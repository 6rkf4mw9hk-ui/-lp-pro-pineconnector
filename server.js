import express from "express";

const app = express();
app.use(express.text({ type: "*/*" }));

const PINECONNECTOR_URL = "https://webhook.pineconnector.com";
const LICENSE_ID = "9123046588629";

const RISK_EUR = 25;

const MIN_LOT = 0.01;
const MAX_LOT = 50;

const MARKETS = {
  NASDAQ: {
    mt5Symbol: "US100.cash",
    valuePerPointPerLot: 0.875
  },

  GER40: {
    mt5Symbol: "GER40.cash",
    valuePerPointPerLot: 1
  }
};

const smaStates = {
  NASDAQ: null,
  GER40: null
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function roundLot(lot) {
  const roundedDown = Math.floor(lot * 100) / 100;

  return Math.max(
    MIN_LOT,
    Math.min(MAX_LOT, Number(roundedDown.toFixed(2)))
  );
}

function extractNumber(msg, label) {
  const regex = new RegExp(`${label}:\\s*([0-9.]+)`, "i");
  const match = msg.match(regex);

  return match ? Number(match[1]) : null;
}

function identifyMarket(...values) {
  const text = values
    .filter(Boolean)
    .join(" ")
    .toUpperCase();

  if (
    text.includes("NASDAQ") ||
    text.includes("US100") ||
    text.includes("NAS100")
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

app.post("/webhook", async (req, res) => {
  const msg = String(req.body || "");

  console.log("Mensaje recibido:", msg);

  let data = null;

  try {
    data = JSON.parse(msg);
  } catch {
    data = null;
  }

  // MENSAJE SMA200
  if (data && typeof data.aboveSMA200 === "boolean") {
    const market = identifyMarket(
      data.ticker,
      data.tickerId,
      data.symbol
    );

    if (!market) {
      console.log("SMA200 ignorada: mercado no reconocido");
      return res.status(200).send("Ignored");
    }

    smaStates[market] = data.aboveSMA200;

    console.log(
      `SMA200 ${market}:`,
      data.aboveSMA200 ? "SOLO BUY" : "SOLO SELL"
    );

    return res.status(200).send("SMA Updated");
  }

  let market = null;
  let action = null;
  let price = null;
  let sl = null;

  // MENSAJE LP PRO JSON
  if (data) {
    market = identifyMarket(
      data.ticker,
      data.tickerId,
      data.symbol
    );

    action = String(data.action || "").toLowerCase();
    price = Number(data.price);
    sl = Number(data.sl);
  } else {
    // MENSAJE LP PRO TEXTO
    market = identifyMarket(msg);

    if (msg.includes("SWEEP BUY")) {
      action = "buy";
    }

    if (msg.includes("SWEEP SELL")) {
      action = "sell";
    }

    price = extractNumber(msg, "Price");
    sl = extractNumber(msg, "SL");
  }

  if (!market || !MARKETS[market]) {
    console.log("Ignorado: mercado no reconocido");
    return res.status(200).send("Ignored");
  }

  console.log(
    `Estado SMA200 ${market}:`,
    smaStates[market] === null
      ? "SIN DATOS"
      : smaStates[market]
        ? "SOLO BUY"
        : "SOLO SELL"
  );

  if (!["buy", "sell"].includes(action)) {
    console.log("Ignorado: no es BUY/SELL");
    return res.status(200).send("Ignored");
  }

  if (smaStates[market] === null) {
    console.log(`Esperando SMA200 de ${market} durante 15 segundos...`);

    await sleep(15000);

    if (smaStates[market] === null) {
      console.log(`Ignorado: no llegó SMA200 de ${market}`);
      return res.status(200).send("Ignored");
    }
  }

  if (action === "buy" && smaStates[market] !== true) {
    console.log(`BUY de ${market} rechazado por SMA200`);
    return res.status(200).send("Ignored");
  }

  if (action === "sell" && smaStates[market] !== false) {
    console.log(`SELL de ${market} rechazado por SMA200`);
    return res.status(200).send("Ignored");
  }

  if (
    !Number.isFinite(price) ||
    !Number.isFinite(sl) ||
    price <= 0 ||
    sl <= 0
  ) {
    console.log("Ignorado: faltan price o SL");
    return res.status(200).send("Ignored");
  }

  const slDistance = Math.abs(price - sl);

  if (slDistance <= 0) {
    console.log("Ignorado: SL inválido");
    return res.status(200).send("Ignored");
  }

  const marketConfig = MARKETS[market];

  const lot = roundLot(
    RISK_EUR /
    (slDistance * marketConfig.valuePerPointPerLot)
  );

  const slPips = Math.round(slDistance * 10);
  const tpPips = slPips * 2;
  const beTrigger = slPips;

  const command =
    `${LICENSE_ID},${action},${marketConfig.mt5Symbol}` +
    `,vol_lots=${lot}` +
    `,sl_pips=${slPips}` +
    `,tp_pips=${tpPips}` +
    `,betrigger=${beTrigger}` +
    `,beoffset=0`;

  const estimatedRisk =
    lot *
    slDistance *
    marketConfig.valuePerPointPerLot;

  console.log("========== OPERACIÓN ==========");
  console.log("Mercado:", market);
  console.log("Símbolo MT5:", marketConfig.mt5Symbol);
  console.log("Acción:", action.toUpperCase());
  console.log("Precio:", price);
  console.log("SL:", sl);
  console.log("Distancia SL:", slDistance);
  console.log("Riesgo estimado €:", estimatedRisk.toFixed(2));
  console.log("Lotaje:", lot);
  console.log("SL Pips:", slPips);
  console.log("TP Pips:", tpPips);
  console.log("Break Even:", beTrigger);
  console.log(
    "SMA200:",
    smaStates[market] ? "SOLO BUY" : "SOLO SELL"
  );
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
