package com.example.billing;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class PayController {
  @PostMapping("/pay")
  String pay() {
    return Billing.charge(new Order(null));
  }

  // The uncaught-error path: the stack as the runtime prints it.
  @ExceptionHandler(Exception.class)
  ResponseEntity<Void> uncaught(Exception error) throws IOException {
    StringWriter stack = new StringWriter();
    error.printStackTrace(new PrintWriter(stack));
    Files.writeString(Path.of(System.getenv("OUT")), stack.toString());
    Files.writeString(Path.of(System.getenv("OUT") + ".type"), error.getClass().getName());
    return ResponseEntity.status(500).build();
  }
}
