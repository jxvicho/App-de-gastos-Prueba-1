import { createCanvas, SKRSContext2D } from "@napi-rs/canvas";
import type { WeeklyReportData } from "./weeklyReportData";

type TextAlign = "left" | "right" | "center";

// Fuentes: "DejaVu Sans" para texto (soporta tildes/ñ), "Noto Color Emoji"
// para los íconos de categoría — ambas se instalan a nivel de SO (ver
// Dockerfile), @napi-rs/canvas las resuelve por nombre de familia vía
// fontconfig, no hace falta registrar rutas a mano.
const FONT = '"DejaVu Sans"';
const EMOJI_FONT = '"Noto Color Emoji"';

const WIDTH = 1080;
const PADDING = 56;
const CONTENT_W = WIDTH - PADDING * 2;

const COLOR_BG = "#FAF9F6";
const COLOR_CARD_BG = "#F1EFEA";
const COLOR_TEXT = "#2B2B28";
const COLOR_TEXT_SOFT = "#8A8A82";
const COLOR_GOOD = "#3FA96B"; // más saturado que el pastel de Ingresos, para que el texto/arco se lea bien
const COLOR_WARN = "#E0A03C";
const COLOR_ACCENT_PEAK = "#4C6FE0"; // día pico en "Gasto por día"
const COLOR_BAR_TRACK = "#E4E2DC";
const COLOR_GAUGE_TRACK = "#E4E2DC";

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function currencySymbol(currency: string): string {
  return currency === "USD" ? "$" : "S/";
}

function money(amount: number, currency: string): string {
  return `${currencySymbol(currency)} ${amount.toFixed(2)}`;
}

function drawText(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  opts: { size: number; weight?: "normal" | "bold"; color?: string; align?: TextAlign; font?: string }
) {
  ctx.font = `${opts.weight === "bold" ? "bold " : ""}${opts.size}px ${opts.font ?? FONT}`;
  ctx.fillStyle = opts.color ?? COLOR_TEXT;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, x, y);
}

/** Tarjeta "Gastaste"/"Ingresaste" con monto y comparación vs. la semana pasada. */
function drawSummaryCard(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  amount: number,
  changePct: number | null,
  changeIsGoodWhenNegative: boolean,
  noDataLabel: string,
  currency: string
) {
  roundedRect(ctx, x, y, w, h, 24);
  ctx.fillStyle = COLOR_CARD_BG;
  ctx.fill();

  drawText(ctx, label, x + 28, y + 44, { size: 24, weight: "bold", color: COLOR_TEXT_SOFT });
  drawText(ctx, money(amount, currency), x + 28, y + 96, { size: 40, weight: "bold" });

  if (amount === 0) {
    drawText(ctx, noDataLabel, x + 28, y + 136, { size: 20, color: COLOR_TEXT_SOFT });
    return;
  }
  if (changePct === null) {
    return;
  }
  const isIncrease = changePct > 0;
  const isGood = isIncrease ? !changeIsGoodWhenNegative : changeIsGoodWhenNegative;
  const color = changePct === 0 ? COLOR_TEXT_SOFT : isGood ? COLOR_GOOD : COLOR_WARN;
  const arrow = changePct === 0 ? "→" : isIncrease ? "↑" : "↓";
  drawText(ctx, `${arrow} ${Math.abs(changePct)}% vs. sem. pasada`, x + 28, y + 136, { size: 20, weight: "bold", color });
}

/** Donut de gastos por categoría + lista top 4 (+"Otras") con ícono real y monto. */
function drawCategoryDonut(ctx: SKRSContext2D, x: number, y: number, w: number, data: WeeklyReportData): number {
  drawText(ctx, "Gastos por categoría", x, y, { size: 28, weight: "bold" });
  const top = y + 40;

  const total = data.categoryBreakdown.reduce((acc, c) => acc + c.amount, 0);
  const cx = x + 150;
  const cy = top + 150;
  const outerR = 130;
  const innerR = 78;

  if (total <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_CARD_BG;
    ctx.fill();
    drawText(ctx, "Sin gastos", cx, cy + 8, { size: 20, color: COLOR_TEXT_SOFT, align: "center" });
  } else {
    if (data.categoryBreakdown.length === 1) {
      // Con una sola categoría el "slice" ocupa el círculo completo (barrido
      // de 2π). Skia (@napi-rs/canvas) no dibuja ese caso límite con el
      // patrón moveTo(centro) + arc(inicio, inicio+2π) + closePath — normaliza
      // los ángulos y el barrido efectivo queda en 0, así que el donut sale
      // vacío. Con una sola categoría no hace falta "cuña": se rellena el
      // círculo completo directamente con su color.
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.fillStyle = data.categoryBreakdown[0].colorHex;
      ctx.fill();
    } else {
      let startAngle = -Math.PI / 2;
      for (const c of data.categoryBreakdown) {
        const slice = (c.amount / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, outerR, startAngle, startAngle + slice);
        ctx.closePath();
        ctx.fillStyle = c.colorHex;
        ctx.fill();
        startAngle += slice;
      }
    }
    // Agujero del donut
    ctx.beginPath();
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_BG;
    ctx.fill();
    drawText(ctx, money(total, data.currency), cx, cy - 4, { size: 24, weight: "bold", align: "center" });
    drawText(ctx, "total", cx, cy + 22, { size: 16, color: COLOR_TEXT_SOFT, align: "center" });
  }

  // Lista a la derecha del donut.
  const listX = x + 340;
  let rowY = top + 20;
  const rowH = 56;
  data.categoryBreakdown.forEach((c) => {
    ctx.beginPath();
    ctx.arc(listX + 12, rowY - 8, 10, 0, Math.PI * 2);
    ctx.fillStyle = c.colorHex;
    ctx.fill();
    drawText(ctx, c.icon, listX + 34, rowY, { size: 24, font: EMOJI_FONT });
    drawText(ctx, c.name, listX + 76, rowY, { size: 22 });
    drawText(ctx, money(c.amount, data.currency), x + w, rowY, { size: 22, weight: "bold", align: "right" });
    rowY += rowH;
  });

  return top + 300;
}

/** Barras Lunes-Domingo; el día pico se resalta y es el único con el monto exacto arriba. */
function drawDayBars(ctx: SKRSContext2D, x: number, y: number, w: number, data: WeeklyReportData): number {
  drawText(ctx, "Gasto por día", x, y, { size: 28, weight: "bold" });
  const top = y + 40;
  const chartH = 220;
  const maxAmount = Math.max(...data.dayTotals.map((d) => d.amount), 1);

  const gap = 24;
  const barW = (w - gap * 6) / 7;

  data.dayTotals.forEach((d, i) => {
    const bx = x + i * (barW + gap);
    const isPeak = i === data.peakDayIndex;
    const barH = Math.max(6, (d.amount / maxAmount) * chartH);
    const by = top + chartH - barH;

    if (isPeak) {
      drawText(ctx, money(d.amount, data.currency), bx + barW / 2, by - 14, { size: 18, weight: "bold", color: COLOR_ACCENT_PEAK, align: "center" });
    }

    roundedRect(ctx, bx, by, barW, barH, 10);
    ctx.fillStyle = isPeak ? COLOR_ACCENT_PEAK : COLOR_BAR_TRACK;
    ctx.fill();

    const dayShort = d.label.slice(0, 3);
    drawText(ctx, dayShort, bx + barW / 2, top + chartH + 34, {
      size: 18,
      color: isPeak ? COLOR_ACCENT_PEAK : COLOR_TEXT_SOFT,
      weight: isPeak ? "bold" : "normal",
      align: "center",
    });
  });

  return top + chartH + 60;
}

/** Medidor tipo velocímetro (semicírculo) del % de presupuesto semanal usado. */
function drawBudgetGauge(ctx: SKRSContext2D, x: number, y: number, w: number, data: WeeklyReportData): number {
  drawText(ctx, "Presupuesto semanal", x, y, { size: 28, weight: "bold" });
  const top = y + 40;

  const weeklyBudget = data.weeklyBudget!;
  const pct = weeklyBudget > 0 ? data.totalExpense / weeklyBudget : 0;
  const overBudget = data.totalExpense > weeklyBudget;
  const color = overBudget ? COLOR_WARN : COLOR_GOOD;

  const cx = x + w / 2;
  const cy = top + 190;
  const r = 160;
  const lineWidth = 32;

  // Track completo (semicírculo de 180° a 360°, o sea de izquierda a derecha por arriba)
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI * 2);
  ctx.strokeStyle = COLOR_GAUGE_TRACK;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  // Arco de progreso, capado visualmente en 100% (si se pasó, el texto ya lo aclara).
  const progress = Math.min(pct, 1);
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * progress);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  drawText(ctx, `${Math.round(pct * 100)}%`, cx, cy - 10, { size: 52, weight: "bold", align: "center", color });
  drawText(ctx, "usado", cx, cy + 24, { size: 18, color: COLOR_TEXT_SOFT, align: "center" });

  const diff = Math.abs(weeklyBudget - data.totalExpense);
  const diffLabel = overBudget ? `Te pasaste por ${money(diff, data.currency)}` : `Te quedan ${money(diff, data.currency)}`;
  drawText(ctx, diffLabel, cx, cy + 70, { size: 22, weight: "bold", align: "center", color });

  return cy + 110;
}

function drawFooter(ctx: SKRSContext2D, x: number, y: number, w: number, data: WeeklyReportData): number {
  const parts: string[] = [];
  if (data.topCategory) {
    // El ícono va aparte en su propia columna (a la izquierda) — no se repite
    // acá porque el texto usa la fuente de letras (sin glifos de emoji).
    parts.push(`${data.topCategory.name} fue tu categoría con más gasto esta semana — ${data.topCategory.pct}% del total.`);
  }
  if (data.peakDay) {
    parts.push(`El ${data.peakDay.label.toLowerCase()} concentró tu mayor gasto diario, con ${money(data.peakDay.amount, data.currency)}.`);
  }
  if (parts.length === 0) {
    parts.push("No tuviste gastos confirmados esta semana.");
  }
  const text = parts.join(" ");

  // Columna de ícono aparte (ancho fijo) para que nunca choque con el texto,
  // que empieza después de esa columna con su propio margen.
  const iconColW = 84;
  const textX = x + iconColW;
  const textMaxWidth = w - iconColW - 32;
  const lineHeight = 30;

  ctx.font = `20px ${FONT}`;
  const lines = wrapLines(ctx, text, textMaxWidth);
  const textBlockH = lines.length * lineHeight;
  const boxH = Math.max(120, textBlockH + 64);

  roundedRect(ctx, x, y, w, boxH, 20);
  ctx.fillStyle = COLOR_CARD_BG;
  ctx.fill();

  drawText(ctx, data.topCategory?.icon ?? "📊", x + iconColW / 2, y + boxH / 2 + 14, { size: 36, font: EMOJI_FONT, align: "center" });

  let lineY = y + (boxH - textBlockH) / 2 + 22;
  ctx.font = `20px ${FONT}`;
  ctx.fillStyle = COLOR_TEXT;
  ctx.textAlign = "left";
  lines.forEach((line) => {
    ctx.fillText(line, textX, lineY);
    lineY += lineHeight;
  });

  return y + boxH;
}

/** Parte `text` en líneas que entran en `maxWidth` con la fuente ya seteada en `ctx`. */
function wrapLines(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Dibuja el reporte semanal completo (Parte 2 del diseño validado) y
 * devuelve el PNG como Buffer, listo para subir a WhatsApp. Alto dinámico:
 * la sección de presupuesto se omite del todo si el usuario no tiene uno
 * configurado ese mes (no un 0%/S/0 engañoso).
 */
export function buildWeeklyReportImage(data: WeeklyReportData): Buffer {
  const hasBudgetSection = data.weeklyBudget !== null;
  const height = hasBudgetSection ? 1620 : 1320;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLOR_BG;
  ctx.fillRect(0, 0, WIDTH, height);

  // 1) Encabezado
  let cursorY = PADDING + 36;
  drawText(ctx, `Hola ${data.userName}, así te fue esta semana`, PADDING, cursorY, { size: 34, weight: "bold" });
  cursorY += 34;
  drawText(ctx, data.weekLabel, PADDING, cursorY, { size: 22, color: COLOR_TEXT_SOFT });
  cursorY += 40;

  // 2) Tarjetas Gastaste / Ingresaste
  const cardGap = 24;
  const cardW = (CONTENT_W - cardGap) / 2;
  const cardH = 176;
  drawSummaryCard(ctx, PADDING, cursorY, cardW, cardH, "Gastaste", data.totalExpense, data.expenseChangePct, true, "sin gastos", data.currency);
  drawSummaryCard(
    ctx,
    PADDING + cardW + cardGap,
    cursorY,
    cardW,
    cardH,
    "Ingresaste",
    data.totalIncome,
    data.totalIncome === 0 ? null : data.incomeChangePct,
    false,
    "sin ingresos",
    data.currency
  );
  cursorY += cardH + 56;

  // 3) Gastos por categoría
  cursorY = drawCategoryDonut(ctx, PADDING, cursorY, CONTENT_W, data) + 20;

  // 4) Gasto por día
  cursorY = drawDayBars(ctx, PADDING, cursorY, CONTENT_W, data) + 20;

  // 5) Presupuesto semanal (omitido si no hay presupuesto configurado)
  if (hasBudgetSection) {
    cursorY = drawBudgetGauge(ctx, PADDING, cursorY, CONTENT_W, data) + 30;
  }

  // 6) Pie de página
  drawFooter(ctx, PADDING, cursorY, CONTENT_W, data);

  return canvas.toBuffer("image/png");
}
