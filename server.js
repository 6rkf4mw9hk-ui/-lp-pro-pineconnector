import express from "express";

const app = express();
app.use(express.text({ type: "*/*" }));

const PINECONNECTOR_URL = "https://webhook.pineconnector.com";
const LICENSE_ID = "9123046588629";

app.post("/webhook", async (req, res) => {
  const msg = String(req.body || "");

  console.log("Mensaje recibido:", msg);

  let command = null;

  if (msg.includes("SWEEP BUY") && msg.includes("EURUSD")) {
    command = `${LICENSE_ID},buy,EURUSD,vol_lots=26.5,sl_pips=7,tp_pips=14,betrigger=7,beoffset=0`;
  }

  if (msg.includes("SWEEP SELL") && msg.includes("EURUSD")) {
    command = `${LICENSE_ID},sell,EURUSD,vol_lots=26.5,sl_pips=7,tp_pips=14,betrigger=7,beoffset=0`;
  }

  if (!command) {
    console.log("Ignorado:", msg);
    return res.status(200).send("Ignored");
  }

  console.log("Enviando a PineConnector:", command);

  await fetch(PINECONNECTOR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain"
    },
    body: command
  });

  res.status(200).send("Sent");
});

app.listen(process.env.PORT || 10000, () => {
  console.log("Servidor iniciado");
});
