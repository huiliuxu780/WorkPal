package com.workpal.runtime;

/**
 * RUN-FAILURE-01: a failure raised at this process's model-stream boundary,
 * carrying the category selected there from the provider's stable HTTP status
 * and exception types. The message is fixed on purpose — provider messages can
 * carry credential-bearing URLs and belong in no wire event, log line or
 * persisted Run error.
 */
final class ModelStreamFailure extends RuntimeException {
    private final String category;

    ModelStreamFailure(String category, Throwable cause) {
        super("Agent execution failed", cause);
        this.category = category;
    }

    String category() {
        return category;
    }
}
