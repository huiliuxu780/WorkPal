package com.workpal.runtime;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** Container healthcheck without shell, curl, or an extra runtime. */
public final class RuntimeHealthcheck {
    public static void main(String[] args) throws Exception {
        var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:8090/health"))
                .timeout(Duration.ofSeconds(2)).GET().build();
        var response = client.send(request, HttpResponse.BodyHandlers.discarding());
        if (response.statusCode() != 200) System.exit(1);
    }
}
