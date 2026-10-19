package com.workpal.runtime;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AG-04: loads fixed prompt segment texts from the classpath resources that
 * Maven packages from the repository-root prompts/ tree (single source of
 * truth; the TS side inlines the same files at build time). The jar never
 * reads a developer checkout at runtime.
 *
 * Text contract (identical to scripts/generate-prompt-texts.mjs): a segment
 * value is the resource content minus exactly ONE trailing newline; all other
 * bytes are preserved verbatim.
 *
 * Rendering fills {{key}} placeholders in a SINGLE pass over the template:
 * dynamic values are inserted verbatim via Matcher.quoteReplacement and are
 * never re-scanned, so a value containing {{...}}, $ sequences, quotes,
 * newlines or XML stays inert data. This is text loading and filling only —
 * no template language, conditionals or nesting; the conditional assembly
 * logic stays in the typed callers (PromptComposer, RuntimeEngine).
 */
public final class PromptTexts {
    private static final Map<String, String> CACHE = new ConcurrentHashMap<>();
    private static final Pattern PLACEHOLDER = Pattern.compile("\\{\\{(\\w+)\\}\\}");

    private PromptTexts() {}

    public static String load(String id) {
        return CACHE.computeIfAbsent(id, key -> {
            String resource = "/prompts/" + key + ".md";
            try (InputStream stream = PromptTexts.class.getResourceAsStream(resource)) {
                if (stream == null) {
                    throw new IllegalStateException("prompt segment resource missing: " + resource);
                }
                String text = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
                if (text.endsWith("\n")) {
                    text = text.substring(0, text.length() - 1);
                }
                return text;
            } catch (IOException error) {
                throw new IllegalStateException("prompt segment unreadable: " + resource, error);
            }
        });
    }

    public static String render(String id, Map<String, String> vars) {
        Matcher matcher = PLACEHOLDER.matcher(load(id));
        StringBuilder out = new StringBuilder();
        while (matcher.find()) {
            String key = matcher.group(1);
            String value = vars.get(key);
            if (value == null) {
                throw new IllegalStateException("prompt segment " + id + " requires variable " + key);
            }
            matcher.appendReplacement(out, Matcher.quoteReplacement(value));
        }
        matcher.appendTail(out);
        return out.toString();
    }
}
