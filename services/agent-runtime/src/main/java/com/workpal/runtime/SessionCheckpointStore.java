package com.workpal.runtime;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.agentscope.core.state.AgentState;
import io.agentscope.core.state.JsonFileAgentStateStore;
import io.agentscope.core.message.ToolCallState;
import io.agentscope.core.message.ToolUseBlock;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * RT-26: per-Run snapshot of AgentScope's native session slot.
 *
 * <p>AgentScope persists a chat session under one slot derived from user,
 * Space, Bot, Thread and generation. A paused Run leaves that slot holding an
 * unresolved tool call, so a different Run must never enter the same slot and
 * no timeout may hand it over. {@link #inspectAndDetach} inspects the slot and,
 * only when a pending native call exists, atomically moves the whole slot into
 * a checkpoint directory bound to the Run, Attempt, admission fence and
 * suspension key. The shared slot is then empty (or absent), which is the
 * Runtime's durable proof that the next Run starts clean.
 *
 * <p>The manifest is the proof. It is written inside the checkpoint before the
 * slot is moved for a re-entrant retry, then upgraded to {@code detached} after
 * the move. A crash before the manifest leaves the slot untouched; a crash
 * between the move and the upgrade is repaired by the next identical call
 * because the slot can no longer contain that Run's state.
 */
final class SessionCheckpointStore {
    private static final int MANIFEST_VERSION = 1;
    private static final String MANIFEST = "manifest.json";
    private static final String STATE_DIR = "session";
    private final ObjectMapper json;
    private final Path root;
    private final Path stateRoot;
    private final Object lock = new Object();

    SessionCheckpointStore(ObjectMapper json, Path checkpointRoot, Path stateRoot) {
        this.json = json;
        this.root = checkpointRoot;
        this.stateRoot = stateRoot;
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Binding(String sessionKey, String runId, String executionId, String attemptId,
            long fence, String suspensionKey, String checkpointId) {
        void validate() {
            if (blank(sessionKey) || blank(runId) || blank(executionId) || blank(attemptId)
                    || blank(suspensionKey) || fence <= 0 || !checkpointId.matches("[A-Za-z0-9_-]{8,120}")) {
                throw new IllegalArgumentException("Invalid pending-state binding");
            }
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Manifest(int version, String checkpointId, String sessionKey, String runId,
            String executionId, String attemptId, long fence, String suspensionKey, String digest,
            List<PendingCall> pendingCalls, String status, String createdAt, String instanceId,
            String resumedExecutionId, String resumedAttemptId, Long resumedFence,
            String resumedSuspensionKey) {
        boolean matches(Binding binding) {
            return checkpointId.equals(binding.checkpointId())
                    && sessionKey.equals(binding.sessionKey())
                    && runId.equals(binding.runId())
                    && executionId.equals(binding.executionId())
                    && attemptId.equals(binding.attemptId())
                    && fence == binding.fence()
                    && suspensionKey.equals(binding.suspensionKey());
        }

        Manifest detached() {
            return new Manifest(version, checkpointId, sessionKey, runId, executionId, attemptId,
                    fence, suspensionKey, digest, pendingCalls, "detached", createdAt, instanceId,
                    resumedExecutionId, resumedAttemptId, resumedFence, resumedSuspensionKey);
        }

        Manifest resumed(String execution, String attempt, long resumedFence,
                String resumedKey) {
            return new Manifest(version, checkpointId, sessionKey, runId, executionId, attemptId,
                    fence, suspensionKey, digest, pendingCalls, "resumed", createdAt, instanceId,
                    execution, attempt, resumedFence, resumedKey);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record PendingCall(String id, String name, String state) {}

    record Proof(String kind, String checkpointId, String digest, List<PendingCall> pendingCalls) {
        Map<String, Object> wire(String instanceId) {
            List<Map<String, Object>> calls = new ArrayList<>();
            for (PendingCall call : pendingCalls) calls.add(Map.of(
                    "id", call.id() == null ? "" : call.id(),
                    "name", call.name() == null ? "tool" : call.name(),
                    "state", call.state() == null ? "pending" : call.state()));
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("kind", kind);
            body.put("checkpointId", checkpointId);
            body.put("digest", digest);
            body.put("pendingCalls", calls);
            body.put("runtimeInstanceId", instanceId);
            return body;
        }
    }

    static final class Conflict extends IOException {
        Conflict(String message) { super(message); }
    }

    Proof inspectAndDetach(String botId, String tenant, String session, Binding binding)
            throws IOException {
        binding.validate();
        synchronized (lock) {
            Path manifestPath = manifestPath(botId, binding.checkpointId());
            Path sessionDir = sessionDir(botId, tenant, session);
            Path checkpointSession = checkpointDir(botId, binding.checkpointId()).resolve(STATE_DIR);
            Manifest existing = readManifest(manifestPath);
            if (existing != null) {
                if (!existing.matches(binding)) {
                    throw new Conflict("Checkpoint belongs to a different execution binding");
                }
                if ("detached".equals(existing.status()) || "resumed".equals(existing.status())) {
                    // The shared slot must not contain this Run's live state again
                    // unless a resume already restored it under a new binding.
                    if ("resumed".equals(existing.status())) {
                        return new Proof("detached", existing.checkpointId(), existing.digest(),
                                existing.pendingCalls());
                    }
                    if (!Files.exists(sessionDir)) {
                        return new Proof("detached", existing.checkpointId(), existing.digest(),
                                existing.pendingCalls());
                    }
                    throw new Conflict("Checkpoint was detached but the shared slot is occupied");
                }
                if ("preparing".equals(existing.status())) {
                    if (Files.exists(checkpointSession)) {
                        // Crash after the atomic move but before the manifest was
                        // upgraded: the state is already isolated under this id.
                        writeManifest(manifestPath, existing.detached());
                        return new Proof("detached", existing.checkpointId(), existing.digest(),
                                existing.pendingCalls());
                    }
                    if (!Files.exists(sessionDir)) {
                        throw new Conflict("Prepared checkpoint state is missing");
                    }
                    // Crash before the move: the slot is untouched, so continue
                    // below with the identical deterministic checkpoint id.
                }
                if ("clean".equals(existing.status()) && !Files.exists(sessionDir)) {
                    return new Proof("clean", existing.checkpointId(), existing.digest(),
                            existing.pendingCalls());
                }
            }
            if (!Files.exists(sessionDir)) {
                // No native slot at all: nothing can be inherited by the next Run.
                Proof clean = new Proof("clean", binding.checkpointId(), emptyDigest(), List.of());
                if (existing == null) writeManifest(manifestPath, manifest(binding, clean, "clean"));
                else if (!"clean".equals(existing.status()) || !existing.digest().equals(clean.digest())) {
                    throw new Conflict("Checkpoint slot disappeared after an earlier probe");
                }
                return clean;
            }
            List<PendingCall> pending = pendingCalls(botId, tenant, session);
            String digest = digest(sessionDir);
            if (pending.isEmpty()) {
                Proof clean = new Proof("clean", binding.checkpointId(), digest, pending);
                if (existing == null) writeManifest(manifestPath, manifest(binding, clean, "clean"));
                else if (!"clean".equals(existing.status()) || !existing.digest().equals(digest)) {
                    // A slot that was clean earlier now has pending state, or the
                    // bytes changed: the earlier proof can no longer be acked.
                    throw new Conflict("Shared session changed after an earlier probe");
                }
                return clean;
            }
            if (existing == null || !"preparing".equals(existing.status())) {
                if (existing != null && "clean".equals(existing.status())) {
                    throw new Conflict("Shared session changed after the clean proof");
                }
                // Prepare the manifest first: if the process dies before the move,
                // the shared slot is untouched and the identical retry is safe.
                Proof prepared = new Proof("detached", binding.checkpointId(), digest, pending);
                writeManifest(manifestPath, manifest(binding, prepared, "preparing"));
            }
            Files.createDirectories(checkpointSession.getParent());
            if (Files.exists(checkpointSession)) {
                Path displaced = checkpointDir(botId, binding.checkpointId())
                        .resolve("stale-" + UUID.randomUUID());
                Files.move(checkpointSession, displaced, StandardCopyOption.ATOMIC_MOVE);
            }
            moveDirectory(sessionDir, checkpointSession);
            // The move is the atomic isolation boundary. Only after it succeeds is
            // the manifest allowed to claim `detached`.
            Manifest current = readManifest(manifestPath);
            if (current == null) throw new IOException("Checkpoint manifest disappeared");
            writeManifest(manifestPath, current.detached());
            return new Proof("detached", binding.checkpointId(), digest, pending);
        }
    }

    /**
     * Recovery probe: the same binding may return the persisted detached proof
     * or a clean proof when the shared slot holds no pending native call. Any
     * other state is unconfirmed and must not release the recovering owner.
     */
    Proof inspect(String botId, String tenant, String session, Binding binding) throws IOException {
        binding.validate();
        synchronized (lock) {
            Manifest existing = readManifest(manifestPath(botId, binding.checkpointId()));
            if (existing != null) {
                if (!existing.matches(binding)) {
                    throw new Conflict("Checkpoint belongs to a different execution binding");
                }
                if ("detached".equals(existing.status()) || "resumed".equals(existing.status())) {
                    return new Proof("detached", existing.checkpointId(), existing.digest(),
                            existing.pendingCalls());
                }
                if ("preparing".equals(existing.status())
                        && Files.exists(checkpointDir(botId, binding.checkpointId()).resolve(STATE_DIR))) {
                    // The move completed before the crash; the manifest digest is
                    // the durable record of the isolated bytes.
                    return new Proof("detached", existing.checkpointId(), existing.digest(),
                            existing.pendingCalls());
                }
            }
            Path sessionDir = sessionDir(botId, tenant, session);
            if (!Files.exists(sessionDir)) {
                return new Proof("clean", binding.checkpointId(), emptyDigest(), List.of());
            }
            List<PendingCall> pending = pendingCalls(botId, tenant, session);
            if (!pending.isEmpty()) {
                throw new Conflict("Shared session still holds pending native state");
            }
            return new Proof("clean", binding.checkpointId(), digest(sessionDir), pending);
        }
    }

    /**
     * RT-26 restart recovery: is the durable manifest bound to this exact
     * execution binding? The manifest is the persisted ownership binding of the
     * slot, so an exact match (checkpoint id, session key, run, attempt,
     * execution, fence and suspension key) lets a restarted Runtime re-adopt
     * the owner it lost. Any mismatch — another run, another fence, another
     * suspension key, or no manifest at all — is not adoptable and stays a
     * conflict.
     */
    boolean manifestBinds(String botId, Binding binding) throws IOException {
        binding.validate();
        synchronized (lock) {
            Manifest manifest = readManifest(manifestPath(botId, binding.checkpointId()));
            return manifest != null && manifest.matches(binding);
        }
    }

    /**
     * Restore a detached checkpoint for THIS Run under a new execution binding.
     * The source binding, digest, and target Run are verified against the
     * manifest; a different Run can never consume another Run's checkpoint.
     */
    boolean restore(String botId, String tenant, String session, RunRequest.CheckpointResume resume,
            String currentRunId) throws IOException {
        if (resume == null) return false;
        if (!currentRunId.equals(resume.sourceRunId())) {
            throw new Conflict("Checkpoint source Run does not match the executing Run");
        }
        Binding source = new Binding(resume.sessionKey(), resume.sourceRunId(),
                resume.sourceExecutionId(), resume.sourceAttemptId(), resume.sourceFence(),
                resume.sourceSuspensionKey(), resume.checkpointId());
        source.validate();
        Binding target = new Binding(resume.sessionKey(), currentRunId, resume.executionId(),
                resume.attemptId(), resume.fence(), resume.suspensionKey(), resume.checkpointId());
        target.validate();
        if (resume.fence() == resume.sourceFence()) {
            throw new Conflict("Resume must use a new execution fence");
        }
        if (resume.suspensionKey().equals(resume.sourceSuspensionKey())) {
            throw new Conflict("Resume must use a new suspension key");
        }
        synchronized (lock) {
            Manifest manifest = readManifest(manifestPath(botId, resume.checkpointId()));
            if (manifest == null || !manifest.matches(source)) {
                throw new Conflict("Checkpoint is missing or bound to a different Run");
            }
            if (!"detached".equals(manifest.status()) && !"resumed".equals(manifest.status())) {
                throw new Conflict("Checkpoint is not detached");
            }
            if (!manifest.digest().equals(resume.digest())) {
                throw new Conflict("Checkpoint digest does not match");
            }
            Path sessionDir = sessionDir(botId, tenant, session);
            boolean restoredByThisExecution = resume.executionId().equals(manifest.resumedExecutionId())
                    && resume.attemptId().equals(manifest.resumedAttemptId())
                    && Long.valueOf(resume.fence()).equals(manifest.resumedFence())
                    && resume.suspensionKey().equals(manifest.resumedSuspensionKey());
            if (restoredByThisExecution && Files.exists(sessionDir)) {
                return true; // Idempotent retry after a crash past the atomic restore.
            }
            if (Files.exists(sessionDir)) {
                if (digest(sessionDir).equals(manifest.digest())) {
                    // Crash after the atomic restore but before the manifest was
                    // upgraded to `resumed`: the slot already holds this checkpoint.
                    writeManifest(manifestPath(botId, resume.checkpointId()),
                            manifest.resumed(resume.executionId(), resume.attemptId(),
                                    resume.fence(), resume.suspensionKey()));
                    return true;
                }
                List<PendingCall> pending = pendingCalls(botId, tenant, session);
                if (!pending.isEmpty()) {
                    throw new Conflict("Shared session holds another Run's pending state");
                }
                // A terminal Run's clean native state is superseded by the
                // checkpoint; PostgreSQL remains the authority for its history.
                Path displaced = checkpointRoot(botId)
                        .resolve("displaced")
                        .resolve(manifest.checkpointId() + "-" + UUID.randomUUID());
                Files.createDirectories(displaced.getParent());
                moveDirectory(sessionDir, displaced);
            }
            Path checkpointSession = checkpointDir(botId, resume.checkpointId()).resolve(STATE_DIR);
            if (!Files.exists(checkpointSession)) {
                throw new Conflict("Checkpoint state was already consumed");
            }
            Files.createDirectories(sessionDir.getParent());
            Path staging = sessionDir.getParent().resolve(".restore-" + UUID.randomUUID());
            copyDirectory(checkpointSession, staging);
            moveDirectory(staging, sessionDir);
            writeManifest(manifestPath(botId, resume.checkpointId()),
                    manifest.resumed(resume.executionId(), resume.attemptId(), resume.fence(),
                            resume.suspensionKey()));
            return true;
        }
    }

    private Manifest manifest(Binding binding, Proof proof, String status) {
        return new Manifest(MANIFEST_VERSION, binding.checkpointId(), binding.sessionKey(),
                binding.runId(), binding.executionId(), binding.attemptId(), binding.fence(),
                binding.suspensionKey(), proof.digest(), proof.pendingCalls(), status,
                Instant.now().toString(), null, null, null, null, null);
    }

    private List<PendingCall> pendingCalls(String botId, String tenant, String session)
            throws IOException {
        Path sessionDir = sessionDir(botId, tenant, session);
        if (!Files.exists(sessionDir)) return List.of();
        JsonFileAgentStateStore store = new JsonFileAgentStateStore(storeRoot(botId));
        Optional<AgentState> state = store.get(tenant, session, "agent_state", AgentState.class);
        if (state.isEmpty()) return List.of();
        List<PendingCall> calls = new ArrayList<>();
        for (ToolUseBlock call : RuntimeEngine.pendingToolCalls(state.get())) {
            calls.add(new PendingCall(call.getId(), call.getName(),
                    call.getState() == null ? "pending" : call.getState().name()));
            if ("ASKING".equals(calls.getLast().state())) {
                calls.set(calls.size() - 1, new PendingCall(call.getId(), call.getName(), "asking"));
            }
        }
        return calls;
    }

    private String digest(Path sessionDir) throws IOException {
        try (Stream<Path> paths = Files.walk(sessionDir)) {
            List<Path> files = paths.filter(Files::isRegularFile)
                    .sorted(Comparator.comparing(path -> sessionDir.relativize(path).toString()))
                    .toList();
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            sha.update("workpal-session-checkpoint-v1\0".getBytes(StandardCharsets.UTF_8));
            for (Path file : files) {
                sha.update(sessionDir.relativize(file).toString().getBytes(StandardCharsets.UTF_8));
                sha.update((byte) 0);
                sha.update(Files.readAllBytes(file));
                sha.update((byte) 0);
            }
            return HexFormat.of().formatHex(sha.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static String emptyDigest() {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            sha.update("workpal-session-checkpoint-v1\0".getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(sha.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private Path storeRoot(String botId) {
        return stateRoot.resolve(SessionSlots.hash(botId));
    }

    private Path sessionDir(String botId, String tenant, String session) {
        return storeRoot(botId).resolve(tenant).resolve(session);
    }

    private Path checkpointRoot(String botId) {
        return root.resolve(SessionSlots.hash(botId));
    }

    private Path checkpointDir(String botId, String checkpointId) {
        return checkpointRoot(botId).resolve(checkpointId);
    }

    private Path manifestPath(String botId, String checkpointId) {
        return checkpointDir(botId, checkpointId).resolve(MANIFEST);
    }

    private Manifest readManifest(Path path) throws IOException {
        if (!Files.exists(path)) return null;
        return json.readValue(Files.readString(path, StandardCharsets.UTF_8), Manifest.class);
    }

    private void writeManifest(Path path, Manifest manifest) throws IOException {
        Files.createDirectories(path.getParent());
        Path tmp = path.resolveSibling(path.getFileName() + ".tmp-" + UUID.randomUUID());
        Files.writeString(tmp, json.writeValueAsString(manifest), StandardCharsets.UTF_8);
        try {
            Files.move(tmp, path, StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException unsupported) {
            Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private static void moveDirectory(Path source, Path target) throws IOException {
        Files.createDirectories(target.getParent());
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException unsupported) {
            Files.move(source, target);
        }
    }

    private static void copyDirectory(Path source, Path target) throws IOException {
        Files.createDirectories(target);
        try (Stream<Path> paths = Files.walk(source)) {
            for (Path path : paths.toList()) {
                Path destination = target.resolve(source.relativize(path).toString());
                if (Files.isDirectory(path)) Files.createDirectories(destination);
                else {
                    Files.createDirectories(destination.getParent());
                    Files.copy(path, destination, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
