FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /app
COPY services/agent-runtime/pom.xml ./pom.xml
RUN mvn -B -q dependency:go-offline
COPY services/agent-runtime/src ./src
RUN mvn -B -q package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/agent-runtime-0.1.0.jar /app/runtime.jar
ENV AGENT_RUNTIME_HOST=0.0.0.0 AGENT_RUNTIME_PORT=8090 AGENT_RUNTIME_DATA_DIR=/data/agent-runtime
EXPOSE 8090
CMD ["java", "-jar", "/app/runtime.jar"]
