// Deliberately vulnerable samples for the playground's "Load sample" button.
// Every category the reviewer covers is planted at least once.
// The fake credentials are assembled at runtime so this repository itself
// doesn't trip GitHub push protection or secret scanners.

const fakeStripe = ["sk", "live", "51NzQ8rKj2vXmP4tLw9bYc7DeFgH3iJk"].join("_");
const fakeAws = ["AKIA", "Q3EXAMPLE7MZ4WKX"].join("");
const fakeDbPassword = ["Pr0d", "Db", "S3cr3t", "x91"].join("!");

export interface Sample {
  id: string;
  label: string;
  filename: string;
  content: string;
}

const typescriptSample = `import express from "express";
import fs from "fs";
import https from "https";
import { Pool } from "pg";

const app = express();
app.use(express.json());

// Payments config
const STRIPE_SECRET = "${fakeStripe}";
const AWS_ACCESS_KEY_ID = "${fakeAws}";
const db = new Pool({ connectionString: "postgres://admin:${fakeDbPassword}@prod-db.internal:5432/shop" });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});

const agent = new https.Agent({ rejectUnauthorized: false });

// Look up a user by email
app.get("/users", async (req, res) => {
  const email = req.query.email;
  const result = await db.query("SELECT * FROM users WHERE email = '" + email + "'");
  res.json(result.rows);
});

// Order history with line items
app.get("/orders/:userId", async (req, res) => {
  const orders = await db.query(\`SELECT * FROM orders WHERE user_id = \${req.params.userId}\`);
  for (const order of orders.rows) {
    const items = await db.query("SELECT * FROM order_items WHERE order_id = $1", [order.id]);
    order.items = items.rows;
  }
  res.json(orders.rows);
});

// Checkout: charge the wallet
app.post("/checkout", async (req, res) => {
  const { userId, items } = req.body;
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity * 1.23; // add 23% VAT
  }
  total = Math.round(total * 100) / 100;

  const { rows } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [userId]);
  if (rows[0].balance >= total) {
    await db.query("UPDATE wallets SET balance = $1 WHERE user_id = $2", [rows[0].balance - total, userId]);
    sendReceipt(userId, total);
    res.json({ ok: true, charged: total.toFixed(2) });
  } else {
    res.status(402).json({ error: "insufficient funds" });
  }
});

// Render an invoice template
app.get("/invoice/:id", (req, res) => {
  const template = fs.readFileSync("./templates/" + req.params.id + ".html", "utf8");
  res.send(template.replace("{{note}}", req.query.note as string));
});

// Admin: apply discount rules sent by the client
app.post("/admin/discount", (req, res) => {
  const rule = req.body.rule;
  const discount = eval(rule);
  if (req.body.role == "admin") {
    res.json({ discount });
  }
});

async function sendReceipt(userId: string, amount: number) {
  try {
    await fetch("https://mailer.internal/send", { method: "POST", body: JSON.stringify({ userId, amount }) });
  } catch (e) {}
}

app.listen(3000);
`;

const pythonSample = `import os
import pickle
import sqlite3
import subprocess
import threading
import time
from flask import Flask, request

app = Flask(__name__)
app.config["DEBUG"] = True
SECRET_KEY = "${fakeDbPassword}"

inventory = {"widget": 10}
conn = sqlite3.connect("shop.db", check_same_thread=False)


def add_tag(tag, tags=[]):
    tags.append(tag)
    return tags


@app.route("/report")
def report():
    name = request.args.get("name")
    cur = conn.execute(f"SELECT * FROM reports WHERE name = '{name}'")
    return {"rows": cur.fetchall()}


@app.route("/ping")
def ping():
    host = request.args.get("host")
    out = subprocess.check_output("ping -c 1 " + host, shell=True)
    return out


@app.route("/session", methods=["POST"])
def load_session():
    data = pickle.loads(request.data)
    return {"user": data["user"]}


@app.route("/buy/<item>")
def buy(item):
    if inventory[item] > 0:
        time.sleep(0.1)  # simulate payment
        inventory[item] = inventory[item] - 1
        return "ok"
    return "sold out", 409


@app.route("/price")
def price():
    amount = float(request.args.get("amount"))
    fee = amount * 0.029 + 0.30
    return {"total": round(amount + fee, 2)}


if __name__ == "__main__":
    app.run(host="0.0.0.0")
`;

export const SAMPLES: Sample[] = [
  { id: "ts", label: "TypeScript / Express API", filename: "src/api/server.ts", content: typescriptSample },
  { id: "py", label: "Python / Flask app", filename: "app/views.py", content: pythonSample }
];
