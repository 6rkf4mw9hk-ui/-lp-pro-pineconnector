import express from "express";

const app = express();
app.use(express.text({ type: "*/*" }));

const PINECONNECTOR_URL = "https://webhook.pineconnector.com";
const LICENSE_ID = "9123046588629";

const ACCOUNT_BALANCE = 10000;
const RISK_PERCENT = 1;
const RISK_EUR = ACCOUNT_BALANCE * (RISK_PERCENT / 100);

const VALUE_PER_POINT_PER_LOT = 0.875;
const MIN_LOT = 0.01;
const MAX_LOT = 50;

let aboveSMA200 = null;

function roundLot(lot) {
  return Math.max(MIN_LOT, Math.min(MAX_LOT, Number(lot.toFixed(2))));
}

function extractNumber(msg, label) {
  const regex = new RegExp(`${label}:\\s*([0-9.]+)`, "i");
  const match = msg.match(regex);
  return match ? Number(match[1]) : null;
}

app.post("/webhook", async (req, res) => {
  const msg = String(req.body || "");
  console.log("Mensaje recibido:", msg);

  let action = null;
  let price = null;
  let sl = null;

  try {
    const data = JSON.parse(msg);

    if (typeof data.aboveSMA200 === "boolean") {
      aboveSMA200 = data.aboveSMA200;

      console.log(
        aboveSMA200
          ? "SMA200 actualizada: PRECIO ENCIMA / SOLO BUY"
          : "SMA200 actualizada: PRECIO DEBAJO / SOLO SELL"
      );

      return res.status(200).send("SMA200 updated");
    }

    action = String(data.action || "").toLowerCase();
    price = Number(data.price);
    sl = Number(data.sl);
  } catch {
    if (msg.includes("SWEEP BUY") && msg.includes("NASDAQ")) action = "buy";
    if (msg.includes("SWEEP SELL") && msg.includes("NASDAQ")) action = "sell";

    price = extractNumber(msg, "Price");
    sl = extractNumber(msg, "SL");
  }

  if (!["buy", "sell"].includes(action)) {
    console.log("Ignorado: no es BUY/SELL");
    return res.status(200).send("Ignored");
  }

  if (aboveSMA200 === null) {
    console.log("Ignorado: todavía no hay dato de SMA200");
    return res.status(200).send("Ignored");
  }

  if (action === "buy" && aboveSMA200 !== true) {
    console.log("BUY ignorado: precio debajo de SMA200");
    return res.status(200).send("Ignored");
  }

  if (action === "sell" && aboveSMA200 !== false) {
    console.log("SELL ignorado: precio encima de SMA200");
    return res.status(200).send("Ignored");
  }

  if (!price || !sl) {
    console.log("Ignorado: faltan price o SL");
    return res.status(200).send("Ignored");
  }

  const slDistance = Math.abs(price - sl);

  if (slDistance <= 0) {
    console.log("Ignorado: SL inválido");
    return res.status(200).send("Ignored");
  }

  const lot = roundLot(RISK_EUR / (slDistance * VALUE_PER_POINT_PER_LOT));

  const slPips = Math.round(slDistance * 10);
  const tpPips = slPips;
  const beTrigger = slPips;

  const command = `${LICENSE_ID},${action},US100.cash,vol_lots=${lot},sl_pips=${slPips},tp_pips=${tpPips},betrigger=${beTrigger},beoffset=0`;

  console.log("========== OPERACIÓN ==========");
  console.log("Acción:", action);
  console.log("Precio:", price);
  console.log("SL:", sl);
  console.log("Distancia SL:", slDistance);
  console.log("Riesgo €:", RISK_EUR);
  console.log("Lotaje:", lot);
  console.log("SMA200:", aboveSMA200 ? "ENCIMA / SOLO BUY" : "DEBAJO / SOLO SELL");
  console.log("Enviando a PineConnector:", command);
  console.log("===============================");

  await fetch(PINECONNECTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: command
  });

  res.status(200).send("Sent");
});

app.listen(process.env.PORT || 10000, () => {
  console.log("Servidor iniciado");
});
