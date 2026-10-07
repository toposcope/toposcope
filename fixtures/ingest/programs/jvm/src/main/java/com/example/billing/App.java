package com.example.billing;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.web.context.WebServerInitializedEvent;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class App {
  public static void main(String[] args) {
    SpringApplication.run(App.class, "--server.port=0", "--server.address=127.0.0.1");
  }

  @Bean
  ApplicationListener<WebServerInitializedEvent> selfRequest(ConfigurableApplicationContext context) {
    return event ->
        new Thread(
                () -> {
                  try {
                    URI pay = URI.create("http://127.0.0.1:" + event.getWebServer().getPort() + "/pay");
                    HttpClient.newHttpClient()
                        .send(
                            HttpRequest.newBuilder(pay).POST(HttpRequest.BodyPublishers.noBody()).build(),
                            HttpResponse.BodyHandlers.discarding());
                  } catch (Exception e) {
                    e.printStackTrace();
                  }
                  System.exit(SpringApplication.exit(context));
                })
            .start();
  }
}
