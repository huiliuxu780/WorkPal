package com.workpal.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;

import io.agentscope.extensions.model.openai.exception.OpenAIException;
import java.io.IOException;
import java.net.SocketTimeoutException;
import org.junit.jupiter.api.Test;
import reactor.core.Exceptions;

final class ModelStreamFailureTest {
    @Test void retryableHttpStatusesUseTheProviderUnavailableCategory() {
        assertEquals("provider_unavailable",
                FailureCategory.forModelStream(new OpenAIException("x", 500, "body")));
        assertEquals("provider_unavailable",
                FailureCategory.forModelStream(new OpenAIException("x", 503, "body")));
        assertEquals("provider_unavailable",
                FailureCategory.forModelStream(new OpenAIException("x", 429, "body")));
    }

    @Test void nonRetryableHttpStatusesAreTerminal() {
        assertEquals("provider_rejected",
                FailureCategory.forModelStream(new OpenAIException("x", 400, "body")));
        assertEquals("provider_rejected",
                FailureCategory.forModelStream(new OpenAIException("x", 401, "body")));
        assertEquals("provider_rejected",
                FailureCategory.forModelStream(new OpenAIException("x", 404, "body")));
    }

    @Test void requestTimeoutStatusIsRetryable() {
        assertEquals("provider_timeout",
                FailureCategory.forModelStream(new OpenAIException("x", 408, "body")));
    }

    @Test void sdkRetryExhaustionUnwrapsToTheProviderStatus() {
        Throwable exhausted = Exceptions.retryExhausted("retries exhausted",
                new OpenAIException("x", 500, "body"));
        assertEquals("provider_unavailable", FailureCategory.forModelStream(exhausted));
    }

    @Test void transportTimeoutsAreRetryable() {
        assertEquals("provider_timeout",
                FailureCategory.forModelStream(new SocketTimeoutException("read timed out")));
    }

    @Test void unknownStreamFailuresAreTerminal() {
        assertEquals("internal", FailureCategory.forModelStream(new IllegalStateException("x")));
    }

    @Test void theWireCategoryComesFromTheStreamBoundary() {
        ModelStreamFailure failure = new ModelStreamFailure(
                FailureCategory.PROVIDER_UNAVAILABLE,
                new OpenAIException("x", 500, "provider body"));
        assertEquals("provider_unavailable", FailureCategory.of(failure, false));
        assertEquals("Agent execution failed", failure.getMessage());
    }

    @Test void interruptionWinsOverTheProviderCategory() {
        assertEquals("cancelled", FailureCategory.of(
                new ModelStreamFailure(FailureCategory.PROVIDER_UNAVAILABLE, new IOException("x")),
                true));
    }
}
