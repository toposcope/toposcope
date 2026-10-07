"use strict";

const fs = require("node:fs");
const express = require("express");
const { charge } = require("./billing");

const app = express();

app.post("/pay", async (req, res) => {
  res.json(charge(req.query));
});

// The uncaught-error path: the stack as the runtime prints it.
app.use((err, req, res, next) => {
  fs.writeFileSync(process.env.OUT, err.stack);
  fs.writeFileSync(`${process.env.OUT}.type`, err.name);
  res.status(500).end();
});

const server = app.listen(0, "127.0.0.1", async () => {
  await fetch(`http://127.0.0.1:${server.address().port}/pay`, { method: "POST" });
  server.close();
});
