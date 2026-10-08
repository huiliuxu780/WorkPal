package com.workpal.runtime;

import io.agentscope.core.model.GenerateOptions;
import io.agentscope.core.model.Model;
import io.agentscope.extensions.model.anthropic.AnthropicChatModel;
import io.agentscope.extensions.model.dashscope.DashScopeChatModel;
import io.agentscope.extensions.model.gemini.GeminiChatModel;
import io.agentscope.extensions.model.openai.OpenAIChatModel;

/** Model credentials are supplied for one Run; no process-global key mutation is used. */
public final class ModelFactory {
    private ModelFactory() {}

    public static Model create(RunRequest.RunModel selected) {
        String provider = selected.provider() == null ? "openai-compatible" : selected.provider();
        String key = RunRequest.blank(selected.apiKey()) ? "not-required" : selected.apiKey();
        GenerateOptions.Builder options = GenerateOptions.builder();
        if (selected.maxTokens() != null) options.maxTokens(selected.maxTokens());
        if (selected.thinkingLevel() != null && !"off".equals(selected.thinkingLevel())) {
            options.reasoningEffort("max".equals(selected.thinkingLevel()) ? "high" : selected.thinkingLevel());
        }
        GenerateOptions generated = options.build();
        int window = selected.contextWindow() == null ? 128_000 : selected.contextWindow();
        if (window <= 0) throw new IllegalArgumentException("Invalid model context window");
        return switch (provider) {
            case "anthropic" -> AnthropicChatModel.builder()
                    .apiKey(key).modelName(selected.id()).baseUrl(selected.baseUrl())
                    .stream(true).defaultOptions(generated).contextWindowSize(window).build();
            case "google" -> GeminiChatModel.builder()
                    .apiKey(key).modelName(selected.id()).baseUrl(selected.baseUrl())
                    .streamEnabled(true).defaultOptions(generated).contextWindowSize(window).build();
            case "dashscope" -> DashScopeChatModel.builder()
                    .apiKey(key).modelName(selected.id()).baseUrl(selected.baseUrl())
                    .stream(true).enableThinking(!"off".equals(selected.thinkingLevel())
                            && (Boolean.TRUE.equals(selected.reasoning()) || selected.thinkingLevel() != null))
                    .defaultOptions(generated).contextWindowSize(window).build();
            case "openai", "openrouter", "openai-compatible", "local", "xai", "deepseek",
                    "minimax", "minimax-cn", "moonshotai", "moonshotai-cn" -> OpenAIChatModel.builder()
                    .apiKey(key).modelName(selected.id()).baseUrl(baseUrl(provider, selected.baseUrl()))
                    .stream(true).generateOptions(generated).contextWindowSize(window).build();
            default -> throw new IllegalArgumentException("Unsupported model provider: " + provider);
        };
    }

    private static String baseUrl(String provider, String configured) {
        if (!RunRequest.blank(configured)) return configured;
        return switch (provider) {
            case "openrouter" -> "https://openrouter.ai/api/v1";
            case "xai" -> "https://api.x.ai/v1";
            case "deepseek" -> "https://api.deepseek.com";
            case "minimax" -> "https://api.minimax.io/v1";
            case "minimax-cn" -> "https://api.minimaxi.com/v1";
            case "moonshotai" -> "https://api.moonshot.ai/v1";
            case "moonshotai-cn" -> "https://api.moonshot.cn/v1";
            default -> null;
        };
    }
}
