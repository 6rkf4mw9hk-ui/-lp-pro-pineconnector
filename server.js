import express from "express";

const app = express();
app.use(express.text({ type: "*/*" }));

const PINECONNECTOR_URL = "https://webhook.pineconnector.com";
const LICENSE_ID = "9123046588629";

const RISK_EUR = 25;
const MIN_LOT = 0.01;
const MAX_LOT = 50;

// Tiempo máximo que esperará la señal actual de SMA200.
const SMA_WAIT_MS = 15000;

// Una SMA recibida hasta 20 segundos antes de LP Pro
// se considera perteneciente al mismo cierre de vela.
const SMA_SYNC_WINDOW_MS = 20000;

const SMA_CHECK_INTERVAL_MS = 200;

const MARKETS = {
  NASDAQ: {
    mt5Symbol: "US100.cash",
    valuePerPointPerLot: 0.875,
    pipsPerPoint: 10
  },

  GER40: {
    mt5Symbol: "GER40.cash",
    valuePerPointPerLot: 1,
    pipsPerPoint: 10
  }
};

// Estado SMA independiente para cada mercado.
const smaStates = {
  NASDAQ: {
    above: null,
    updatedAt: 0,
    price: null,
    sma200: null
  },

  GER40: {
    above: null,
    updatedAt: 0,
    price: null,
    sma200: null
  }
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function identifyMarket(...values) {
  const text = values
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/\s+/g, "");

  if (
    text.includes("NASDAQ") ||
    text.includes("US100") ||
    text.includes("NAS100") ||
    text.includes("USTEC") ||
    text.includes("USTECH100")
  ) {
    return "NASDAQ";
  }

  if (
    text.includes("GER40") ||
    text.includes("DE40") ||
    text.includes("DAX")
  ) {
    return "GER40";
  }

  return null;
}

function hasSynchronizedSma(market, signalReceivedAt) {
  const state = smaStates[market];

  if (!state || typeof state.above !== "boolean") {
    return false;
  }

  const minimumValidTime =
    signalReceivedAt - SMA_SYNC_WINDOW_MS;

  return state.updatedAt >= minimumValidTime;
}

async function waitForSynchronizedSma(market, signalReceivedAt) {
  const deadline = Date.now() + SMA_WAIT_MS;

  while (Date.now() < deadline) {
    if (hasSynchronizedSma(market, signalReceivedAt)) {
      return true;
    }

    await sleep(SMA_CHECK_INTERVAL_MS);
  }

  return hasSynchronizedSma(market, signalReceivedAt);
}

app.post("/webhook", async (req, res) => {
  const rawMessage = String(req.body || "").trim();

  console.log("");
  console.log("Mensaje recibido:", rawMessage);

  let data = null;

  try {
    data = JSON.parse(rawMessage);
  } catch {
    data = null;
  }

  // ==================================================
  // MENSAJE DEL INDICADOR SMA200
  // ==================================================

  if (data && typeof data.aboveSMA200 === "boolean") {
    const market = identifyMarket(
      data.ticker,
      data.tickerId,
      data.symbol
    );

    if (!market || !MARKETS[market]) {
      console.log("SMA200 ignorada: mercado no reconocido");
      return res.status(200).send("Ignored");
    }

    smaStates[market] = {
      above: data.aboveSMA200,
      updatedAt: Date.now(),
      price: Number(data.price),
      sma200: Number(data.sma200)
    };

    console.log(
      `SMA200 ${market}:`,
      data.aboveSMA200 ? "SOLO BUY" : "SOLO SELL"
    );

    console.log("Precio SMA:", data.price);
    console.log("Valor SMA200:", data.sma200);

    return res.status(200).send("SMA Updated");
  }

  // ==================================================
  // MENSAJE DE LP PRO
  // ==================================================

  const signalReceivedAt = Date.now();

  let market = null;
  let action = null;
  let price = null;
  let sl = null;
  let poolStrength = null;

  if (data) {
    market = identifyMarket(
      data.ticker,
      data.tickerId,
      data.symbol
    );

    action = String(data.action || "").toLowerCase();
    price = Number(data.price);
    sl = Number(data.sl);
    poolStrength = Number(data.pool_strength);
  } else {
    market = identifyMarket(rawMessage);

    const upperMessage = rawMessage.toUpperCase();

    if (upperMessage.includes("SWEEP BUY")) {
      action = "buy";
    }

    if (upperMessage.includes("SWEEP SELL")) {
      action = "sell";
    }

    price = extractNumber(rawMessage, "Price");
    sl = extractNumber(rawMessage, "SL");
  }

  if (!market || !MARKETS[market]) {
    console.log("Ignorado: mercado no reconocido");
    return res.status(200).send("Ignored");
  }

  if (!["buy", "sell"].includes(action)) {
    console.log("Ignorado: no es BUY o SELL");
    return res.status(200).send("Ignored");
  }

  // ==================================================
  // ESPERAR LA SMA DEL MISMO CIERRE DE VELA
  // ==================================================

  console.log(
    `Esperando SMA200 sincronizada de ${market} antes de procesar ${action.toUpperCase()}...`
  );

  const smaAvailable = await waitForSynchronizedSma(
    market,
    signalReceivedAt
  );

  if (!smaAvailable) {
    console.log(
      `Ignorado: no llegó una SMA200 actual de ${market} en 15 segundos`
    );

    return res.status(200).send("Ignored");
  }

  const smaState = smaStates[market];

  const smaAgeMs = Date.now() - smaState.updatedAt;

  console.log(
    `SMA200 sincronizada ${market}:`,
    smaState.above ? "SOLO BUY" : "SOLO SELL"
  );

  console.log(
    "Antigüedad del dato SMA:",
    `${smaAgeMs} ms`
  );

  if (action === "buy" && smaState.above !== true) {
    console.log(
      `BUY de ${market} rechazado: precio debajo de SMA200`
    );

    return res.status(200).send("Ignored");
  }

  if (action === "sell" && smaState.above !== false) {
    console.log(
      `SELL de ${market} rechazado: precio encima de SMA200`
    );

    return res.status(200).send("Ignored");
  }

  // ==================================================
  // VALIDAR DATOS DE LA OPERACIÓN
  // ==================================================

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

  if (
    !Number.isFinite(slDistance) ||
    slDistance <= 0
  ) {
    console.log("Ignorado: distancia al SL inválida");
    return res.status(200).send("Ignored");
  }

  const marketConfig = MARKETS[market];

  // ==================================================
  // LOTAJE PARA UN SL MÁXIMO APROXIMADO DE 25 €
  // ==================================================

  const rawLot =
    RISK_EUR /
    (slDistance * marketConfig.valuePerPointPerLot);

  const lot = roundLotDown(rawLot);

  if (!Number.isFinite(lot) || lot < MIN_LOT) {
    console.log("Ignorado: lotaje inválido");
    return res.status(200).send("Ignored");
  }

  const estimatedRisk =
    lot *
    slDistance *
    marketConfig.valuePerPointPerLot;

  // ==================================================
  // RR 1:2 Y BREAK EVEN EN 1R
  // ==================================================

  const slPips = Math.max(
    1,
    Math.round(
      slDistance * marketConfig.pipsPerPoint
    )
  );

  const tpPips = slPips * 2;
  const beTrigger = slPips;

  const command =
    `${LICENSE_ID},${action},${marketConfig.mt5Symbol}` +
    `,vol_lots=${lot}` +
    `,sl_pips=${slPips}` +
    `,tp_pips=${tpPips}` +
    `,betrigger=${beTrigger}` +
    `,beoffset=0`;

  console.log("========== OPERACIÓN ==========");
  console.log("Mercado:", market);
  console.log("Símbolo MT5:", marketConfig.mt5Symbol);
  console.log("Acción:", action.toUpperCase());
  console.log("Precio:", price);
  console.log("SL:", sl);
  console.log("Distancia SL:", slDistance);
  console.log(
    "Riesgo estimado €:",
    estimatedRisk.toFixed(2)
  );
  console.log("Lotaje:", lot);
  console.log("SL Pips:", slPips);
  console.log("TP Pips:", tpPips);
  console.log("Break Even:", beTrigger);

  if (Number.isFinite(poolStrength)) {
    console.log("Pool Strength:", poolStrength);
  }

  console.log(
    "SMA200 confirmada:",
    smaState.above ? "SOLO BUY" : "SOLO SELL"
  );

  console.log(
    "Enviando a PineConnector:",
    command
  );

  console.log("===============================");

  try {
    const response = await fetch(
      PINECONNECTOR_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain"
        },
        body: command
      }
    );

    const responseText = await response.text();

    console.log(
      "Respuesta PineConnector:",
      response.status,
      responseText
    );

    if (!response.ok) {
      console.log(
        "PineConnector rechazó la orden"
      );

      return res
        .status(502)
        .send("PineConnector error");
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
