import express from "express";

const app = express();
app.use(express.text({ type: "*/*" }));

const PINECONNECTOR_URL = "https://webhook.pineconnector.com";
const LICENSE_ID = "9123046588629";

const RISK_EUR = 800;
const VALUE_PER_POINT_PER_LOT = 0.875;

const MIN_LOT = 0.01;
const MAX_LOT = 50;

function roundLot(lot) {
  return Math.max(
    MIN_LOT,
    Math.min(MAX_LOT, Number(lot.toFixed(2)))
  );
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

    action = String(data.action || "").toLowerCase();
    price = Number(data.price);
    sl = Number(data.sl);

  } catch {

    if (
      msg.includes("SWEEP BUY") &&
      msg.includes("NASDAQ")
    ) {
      action = "buy";
    }

    if (
      msg.includes("SWEEP SELL") &&
      msg.includes("NASDAQ")
    ) {
      action = "sell";
    }

    price = extractNumber(msg, "Price");
    sl = extractNumber(msg, "SL");
  }

  if (!["buy", "sell"].includes(action)) {
    console.log("Ignorado, no es BUY/SELL");
    return res.status(200).send("Ignored");
  }

  if (!price || !sl) {
    console.log("Ignorado, no hay Price o SL");
    return res.status(200).send("Ignored");
  }

  const slDistance = Math.abs(price - sl);

  if (slDistance <= 0) {
    console.log("Distancia SL inválida");
    return res.status(200).send("Ignored");
  }

  const lot = roundLot(
    RISK_EUR / (slDistance * VALUE_PER_POINT_PER_LOT)
  );

  const slPips = Math.round(slDistance * 10);

  // TP = 1R
  const tpPips = slPips;

  // BE cuando llegue a 1R
  const beTrigger = slPips;

  const command =
    `${LICENSE_ID},${action},US100.cash,vol_lots=${lot},sl_pips=${slPips},tp_pips=${tpPips},betrigger=${beTrigger},beoffset=0`;

  console.log("=================================");
  console.log("Acción:", action);
  console.log("Precio:", price);
  console.log("SL:", sl);
  console.log("Distancia SL:", slDistance);
  console.log("Lotaje calculado:", lot);
  console.log("Comando:", command);
  console.log("=================================");

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
