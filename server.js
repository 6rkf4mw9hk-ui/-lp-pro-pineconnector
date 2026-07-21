import express from "express";

const app = express();
app.use(express.text({ type: "*/*" }));

const PINECONNECTOR_URL = "https://webhook.pineconnector.com";
const LICENSE_ID = "9123046588629";

const RISK_EUR = 15;

const VALUE_PER_POINT_PER_LOT = 0.875;
const MIN_LOT = 0.01;
const MAX_LOT = 50;

function roundLotDown(lot) {
  const roundedDown = Math.floor(lot * 100) / 100;

  return Math.max(
    MIN_LOT,
    Math.min(MAX_LOT, Number(roundedDown.toFixed(2)))
  );
}

function extractNumber(message, label) {
  const regex = new RegExp(`${label}:\\s*([0-9.]+)`, "i");
  const match = message.match(regex);

  return match ? Number(match[1]) : null;
}

function isNasdaq(...values) {
  const text = values
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/\s+/g, "");

  return (
    text.includes("NASDAQ") ||
    text.includes("US100") ||
    text.includes("NAS100") ||
    text.includes("USTEC") ||
    text.includes("USTECH100")
  );
}

app.post("/webhook", async (req, res) => {
  const rawMessage = String(req.body || "").trim();

  console.log("Mensaje recibido:", rawMessage);

  let data = null;

  try {
    data = JSON.parse(rawMessage);
  } catch {
    data = null;
  }

  let action = null;
  let price = null;
  let sl = null;
  let timeframe = null;
  let poolStrength = null;

  if (data) {
    if (!isNasdaq(data.ticker, data.tickerId, data.symbol)) {
      console.log("Ignorado: no es NASDAQ");
      return res.status(200).send("Ignored");
    }

    action = String(data.action || "").toLowerCase();
    price = Number(data.price);
    sl = Number(data.sl);
    timeframe = String(data.tf || data.timeframe || "");
    poolStrength = Number(data.pool_strength);
  } else {
    if (!isNasdaq(rawMessage)) {
      console.log("Ignorado: no es NASDAQ");
      return res.status(200).send("Ignored");
    }

    const upperMessage = rawMessage.toUpperCase();

    if (upperMessage.includes("SWEEP BUY")) {
      action = "buy";
    }

    if (upperMessage.includes("SWEEP SELL")) {
      action = "sell";
    }

    price = extractNumber(rawMessage, "Price");
    sl = extractNumber(rawMessage, "SL");

    const timeframeMatch = rawMessage.match(/TF:\s*([0-9]+)/i);
    timeframe = timeframeMatch ? timeframeMatch[1] : "";
  }

  if (!["buy", "sell"].includes(action)) {
    console.log("Ignorado: no es BUY o SELL");
    return res.status(200).send("Ignored");
  }

  if (timeframe && timeframe !== "1") {
    console.log(`Ignorado: timeframe ${timeframe}, solo se acepta 1m`);
    return res.status(200).send("Ignored");
  }

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(sl) ||
    price <= 0 ||
    sl <= 0
  ) {
    console.log("Ignorado: faltan Price o SL válidos");
    return res.status(200).send("Ignored");
  }

  const slDistance = Math.abs(price - sl);

  if (!Number.isFinite(slDistance) || slDistance <= 0) {
    console.log("Ignorado: distancia al SL inválida");
    return res.status(200).send("Ignored");
  }

  const rawLot =
    RISK_EUR /
    (slDistance * VALUE_PER_POINT_PER_LOT);

  const lot = roundLotDown(rawLot);

  if (!Number.isFinite(lot) || lot < MIN_LOT) {
    console.log("Ignorado: lotaje inválido");
    return res.status(200).send("Ignored");
  }

  const estimatedRisk =
    lot *
    slDistance *
    VALUE_PER_POINT_PER_LOT;

  const slPips = Math.max(
    1,
    Math.round(slDistance * 10)
  );

  const tpPips = slPips * 2;
  const beTrigger = slPips;

  const command =
    `${LICENSE_ID},${action},US100.cash` +
    `,vol_lots=${lot}` +
    `,sl_pips=${slPips}` +
    `,tp_pips=${tpPips}` +
    `,betrigger=${beTrigger}` +
    `,beoffset=0`;

  console.log("========== OPERACIÓN ==========");
  console.log("Mercado: NASDAQ");
  console.log("Símbolo MT5: US100.cash");
  console.log("Timeframe:", timeframe || "no indicado");
  console.log("Acción:", action.toUpperCase());
  console.log("Precio:", price);
  console.log("SL:", sl);
  console.log("Distancia SL:", slDistance);
  console.log("Riesgo configurado €:", RISK_EUR);
  console.log("Riesgo estimado €:", estimatedRisk.toFixed(2));
  console.log("Lotaje:", lot);
  console.log("SL Pips:", slPips);
  console.log("TP Pips:", tpPips);
  console.log("Break Even:", beTrigger);

  if (Number.isFinite(poolStrength)) {
    console.log("Pool Strength:", poolStrength);
  }

  console.log("Enviando a PineConnector:", command);
  console.log("===============================");

  try {
    const response = await fetch(PINECONNECTOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: command
    });

    const responseText = await response.text();

    console.log(
      "Respuesta PineConnector:",
      response.status,
      responseText
    );

    if (!response.ok) {
      console.log("PineConnector rechazó la orden");
      return res.status(502).send("PineConnector error");
    }

    return res.status(200).send("Sent");
  } catch (error) {
    console.log(
      "Error enviando a PineConnector:",
      error.message
    );

    return res.status(502).send("Send error");
  }
});

app.listen(process.env.PORT || 10000, () => {
  console.log("Servidor iniciado");
});
