package com.workpal.runtime;

import io.agentscope.core.skill.AgentSkill;
import io.agentscope.core.skill.repository.AgentSkillRepository;
import io.agentscope.core.skill.repository.AgentSkillRepositoryInfo;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Immutable run allow-list. The agent cannot add skills or read another run's registry. */
public final class RequestSkillRepository implements AgentSkillRepository {
    private final Map<String, AgentSkill> allowed;

    public RequestSkillRepository(List<RunRequest.SkillDefinition> definitions) {
        this.allowed = definitions.stream()
                .map(item -> new AgentSkill(item.name(), item.description(), item.content(), Map.of(), "workpal"))
                .collect(Collectors.toUnmodifiableMap(AgentSkill::getName, Function.identity()));
    }

    @Override public AgentSkill getSkill(String name) { return allowed.get(name); }
    @Override public List<String> getAllSkillNames() { return List.copyOf(allowed.keySet()); }
    @Override public List<AgentSkill> getAllSkills() { return List.copyOf(allowed.values()); }
    @Override public boolean save(List<AgentSkill> skills, boolean force) { return false; }
    @Override public boolean delete(String skillName) { return false; }
    @Override public boolean skillExists(String skillName) { return allowed.containsKey(skillName); }
    @Override public AgentSkillRepositoryInfo getRepositoryInfo() {
        return new AgentSkillRepositoryInfo("workpal", "request", false);
    }
    @Override public String getSource() { return "workpal"; }
    @Override public void setWriteable(boolean writeable) {
        if (writeable) throw new UnsupportedOperationException("WorkPal skills are read-only in the runtime");
    }
    @Override public boolean isWriteable() { return false; }
}
