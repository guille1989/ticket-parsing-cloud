// Script administrativo — crea (o completa) un tenant DEMO con datos ficticios
// para presentaciones y ejercicios didácticos del dashboard: una panadería-
// cafetería de Madrid ("Horno Castizo") con 4 sucursales y ~3 meses de tickets.
//
// Qué escribe (todo bajo un tenantId fijo, así `delete-tenant.ts` lo borra
// entero cuando ya no haga falta):
//   - Tenants (con el onboarding marcado como completo)
//   - Cognito: el usuario con el que se loguea en el dashboard
//   - Agents: 4 "robots" (uno por sucursal, con ubicación en el mapa)
//   - ActivationCodes: 5 (4 usados, 1 libre)
//   - Tickets: DynamoDB (fuente de verdad operacional)
//   - Analytics: S3, el layout particionado que lee Athena. Los tickets
//     `parsed` van consolidados en un archivo por sucursal y día (miles de
//     archivos de una fila hacen lentas las consultas de Athena); los
//     `needs_review` van en su archivo individual (`analyticsRowKey`)
//     porque `review/handler.ts` los borra/reescribe por esa clave.
//   - Widgets: un dashboard inicial
//
// Es determinístico: cada (sucursal, día) siembra su propio generador, así que
// volver a correrlo regenera exactamente los mismos tickets y solo agrega los
// días que faltan (útil para "estirar" el demo hasta hoy).
//
// Uso (desde ticket-parsing-cloud/):
//   npx tsx scripts/seed-demo-tenant.ts                  # corrida en seco: solo estadísticas
//   npx tsx scripts/seed-demo-tenant.ts --apply          # escribe en AWS
//   npx tsx scripts/seed-demo-tenant.ts --heartbeat      # mantiene "en línea" a los 4 robots (dejar abierto durante la demo)
//   opciones: --months 3   --until 2026-10-20T10:00:00Z   --credentials-file ../demo-credenciales.txt
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { agentKey, ticketKey, ticketStatusGsiKey, widgetKey } from "../src/shared/dynamo.js";

// ───────────────────────────── configuración ─────────────────────────────

const TENANT_ID = "d3a10000-0000-4000-8000-0000000c0de0"; // fijo a propósito: es "el tenant demo"
const BUSINESS_NAME = "Horno Castizo (DEMO)";
const LOGIN_EMAIL = "demo.hornocastizo@theinnoapp.com";
const TIME_ZONE = "Europe/Madrid";
const STACK_NAME = "TicketParsingCloudStack";
const REGION = "us-east-1";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const APPLY = process.argv.includes("--apply");
const MONTHS = Number(argValue("months") ?? 3);
const UNTIL = argValue("until") ? new Date(argValue("until")!) : new Date();
const CREDENTIALS_FILE = argValue("credentials-file") ?? "../demo-hornocastizo-credenciales.txt";

// ─────────────────────────────── utilidades ───────────────────────────────

/** PRNG determinístico (mulberry32) sembrado por un string. */
function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function makeRng(seedText: string) {
  let a = hashString(seedText);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)];
    },
    weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
      const weights = items.map(weight);
      const total = weights.reduce((sum, w) => sum + w, 0);
      if (total <= 0) return undefined;
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    /** Normal aproximada (suma de uniformes). */
    gauss: () => next() + next() + next() + next() - 2,
    uuid: () => {
      const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16)).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

const round2 = (n: number) => Math.round(n * 100) / 100;

function tzOffsetMinutes(date: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "shortOffset" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /GMT([+-])(\d+)(?::(\d+))?/.exec(name ?? "");
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}
/** Hora de pared de Madrid → instante UTC (resuelve el horario de verano). */
function madridToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = tzOffsetMinutes(new Date(guess));
  let utc = guess - first * 60000;
  const second = tzOffsetMinutes(new Date(utc));
  if (second !== first) utc = guess - second * 60000;
  return new Date(utc);
}
const dateKey = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
/** Días desde 2026-01-01 (para interpolar factores). */
const dayNumber = (y: number, mo: number, d: number) => Math.floor(Date.UTC(y, mo - 1, d) / 86400000);

// ───────────────────────────────── catálogo ──────────────────────────────

type Category = "pan" | "bolleria" | "dulce" | "cafe" | "bebida" | "salado" | "menu" | "regalo";

interface Product {
  id: string;
  description: string;
  price: number;
  /** IVA incluido en el precio: pan 4 %, alcohol 21 %, el resto 10 %. */
  vat: 4 | 10 | 21;
  category: Category;
}

const P = (id: string, description: string, price: number, category: Category, vat: 4 | 10 | 21 = 10): Product => ({
  id, description, price, vat, category,
});

const CATALOG: Record<string, Product> = Object.fromEntries(
  [
    P("barra", "Barra de pan", 1.1, "pan", 4),
    P("hogaza", "Hogaza de masa madre", 3.8, "pan", 4),
    P("baguette", "Baguette", 1.25, "pan", 4),
    P("centeno", "Pan de centeno", 3.2, "pan", 4),
    P("chapata", "Chapata", 1.4, "pan", 4),
    P("croissant", "Croissant", 1.8, "bolleria"),
    P("croissantm", "Croissant de mantequilla", 2.2, "bolleria"),
    P("napolitana", "Napolitana de chocolate", 2.1, "bolleria"),
    P("palmera", "Palmera de hojaldre", 2.3, "bolleria"),
    P("ensaimada", "Ensaimada", 2.6, "bolleria"),
    P("tarta_queso", "Tarta de queso (ración)", 4.5, "dulce"),
    P("pastel_nata", "Pastel de nata", 2.2, "dulce"),
    P("torrija", "Torrija", 3.2, "dulce"),
    P("bunuelo", "Buñuelos de viento", 3.5, "dulce"),
    P("hueso", "Huesos de santo", 3.8, "dulce"),
    P("caja_pastas", "Caja de pastas", 9.5, "regalo"),
    P("tarta_entera", "Tarta entera", 24, "regalo"),
    P("solo", "Café solo", 1.4, "cafe"),
    P("cortado", "Cortado", 1.6, "cafe"),
    P("leche", "Café con leche", 1.9, "cafe"),
    P("capuchino", "Capuchino", 2.4, "cafe"),
    P("infusion", "Té / infusión", 2.2, "cafe"),
    P("choco", "Chocolate caliente", 2.8, "cafe"),
    P("hielo", "Café con hielo", 2.2, "cafe"),
    P("zumo", "Zumo de naranja natural", 3.5, "bebida"),
    P("agua", "Agua mineral", 1.5, "bebida"),
    P("refresco", "Refresco", 2.3, "bebida"),
    P("cana", "Caña", 2.4, "bebida", 21),
    P("horchata", "Horchata", 3.2, "bebida"),
    P("granizado", "Granizado de limón", 3.0, "bebida"),
    P("tostada_tomate", "Tostada con tomate y aceite", 2.8, "salado"),
    P("tostada_jamon", "Tostada de jamón ibérico", 4.9, "salado"),
    P("tostada_aguacate", "Tostada de aguacate y huevo", 5.9, "salado"),
    P("bocata_calamares", "Bocadillo de calamares", 6.5, "salado"),
    P("bocata_tortilla", "Bocadillo de tortilla", 4.8, "salado"),
    P("mixto", "Sándwich mixto", 4.2, "salado"),
    P("pincho_tortilla", "Pincho de tortilla", 3.5, "salado"),
    P("empanada", "Empanada gallega (ración)", 3.9, "salado"),
    P("ensalada", "Ensalada de la casa", 7.9, "salado"),
    P("menu", "Menú del día", 13.9, "menu"),
  ].map((product) => [product.id, product]),
);

const DRINKS_HOT = ["solo", "cortado", "leche", "capuchino", "infusion", "choco", "hielo"];
const DRINKS_COLD = ["agua", "refresco", "cana", "zumo", "horchata", "granizado"];
const BREAKFAST_FOOD = ["croissant", "croissantm", "napolitana", "palmera", "ensaimada", "tostada_tomate", "tostada_jamon", "tostada_aguacate", "pincho_tortilla"];
const LUNCH_FOOD = ["bocata_calamares", "bocata_tortilla", "mixto", "pincho_tortilla", "empanada", "ensalada", "menu"];
const SWEETS = ["tarta_queso", "pastel_nata", "torrija", "bunuelo", "hueso", "napolitana", "palmera", "croissant"];
const BREADS = ["barra", "hogaza", "baguette", "centeno", "chapata"];
const GIFTS = ["caja_pastas", "tarta_entera"];

/** Precio vigente de un producto ese día (el menú sube el 1 de octubre). */
function priceOn(product: Product, key: string): number {
  if (product.id === "menu" && key >= "2026-10-01") return 14.5;
  return product.price;
}

/** Disponibilidad/estacionalidad de un producto ese día (multiplicador del peso). */
function seasonality(productId: string, key: string): number {
  const month = Number(key.slice(5, 7));
  const summer = key <= "2026-09-10" ? 1 : key <= "2026-09-30" ? 0.55 : key <= "2026-10-12" ? 0.2 : 0.06;
  switch (productId) {
    case "horchata":
    case "granizado":
    case "hielo":
      return summer * (month === 7 || month === 8 ? 1.4 : 1);
    case "cana":
      return month <= 8 ? 1.3 : 1;
    case "choco":
      return key < "2026-09-15" ? 0.35 : key < "2026-10-05" ? 1 : 1.9;
    case "torrija":
      return key < "2026-09-20" ? 0.5 : 1.4;
    case "bunuelo":
    case "hueso":
      return key >= "2026-10-15" ? 2.2 : 0; // aparecen a mitad de octubre (Todos los Santos)
    case "tarta_entera":
      return key >= "2026-09-01" ? 1 : 0.7;
    default:
      return 1;
  }
}

// ──────────────────────────────── sucursales ─────────────────────────────

interface Branch {
  key: string;
  agentName: string;
  label: string;
  lat: number;
  lng: number;
  ports: string[];
  /** Tickets de un día "normal" (factor 1). */
  baseDaily: number;
  priceFactor: number;
  /** domingo(0)…sábado(6) */
  weekday: number[];
  /** Anclas [fecha, factor] interpoladas linealmente. */
  season: Array<[string, number]>;
  /** Crecimiento diario compuesto (Lavapiés va en alza). */
  dailyGrowth: number;
  /** Multiplicadores de peso por producto. */
  productBias: Record<string, number>;
  /** Peso por franja: mañana / mediodía / tarde. */
  slotBias: [number, number, number];
  sundayClosesAt: number;
  tipChance: number;
  discountChance: number;
}

const BRANCHES: Branch[] = [
  {
    key: "sol", agentName: "TPV Sol", label: "Horno Castizo · Puerta del Sol", lat: 40.4169, lng: -3.7035,
    ports: ["TPV-CAJA1", "TPV-CAJA2"], baseDaily: 175, priceFactor: 1.08,
    weekday: [1.15, 0.92, 0.95, 1.0, 1.05, 1.22, 1.38],
    season: [["2026-07-01", 1.0], ["2026-08-10", 1.14], ["2026-09-05", 1.04], ["2026-10-20", 0.96]],
    dailyGrowth: 0, slotBias: [0.9, 1.15, 1.0], sundayClosesAt: 22, tipChance: 0.05, discountChance: 0.01,
    productBias: { bocata_calamares: 3, cana: 1.6, tostada_jamon: 1.5, ensaimada: 1.6, menu: 0.35, hogaza: 0.6, barra: 0.5 },
  },
  {
    key: "salamanca", agentName: "TPV Salamanca", label: "Horno Castizo · Barrio de Salamanca", lat: 40.4308, lng: -3.6799,
    ports: ["TPV-CAJA1", "TPV-CAJA2"], baseDaily: 120, priceFactor: 1.12,
    weekday: [1.18, 0.82, 0.88, 0.95, 1.0, 1.12, 1.35],
    season: [["2026-07-01", 0.92], ["2026-08-03", 0.55], ["2026-08-24", 0.6], ["2026-09-08", 1.0], ["2026-10-20", 1.08]],
    dailyGrowth: 0, slotBias: [1.1, 0.85, 1.2], sundayClosesAt: 21, tipChance: 0.04, discountChance: 0.01,
    productBias: { tostada_aguacate: 3, croissantm: 2, zumo: 2, caja_pastas: 4, tarta_entera: 4, tarta_queso: 1.5, capuchino: 1.6, centeno: 2, hogaza: 1.8, menu: 0.8, cana: 0.5 },
  },
  {
    key: "chamberi", agentName: "TPV Chamberí", label: "Horno Castizo · Chamberí", lat: 40.4337, lng: -3.7036,
    ports: ["TPV-CAJA1"], baseDaily: 135, priceFactor: 1.0,
    weekday: [0.45, 1.12, 1.16, 1.16, 1.14, 1.04, 0.78],
    season: [["2026-07-01", 0.9], ["2026-08-03", 0.52], ["2026-08-24", 0.58], ["2026-09-08", 1.0], ["2026-10-20", 1.06]],
    dailyGrowth: 0, slotBias: [1.15, 1.3, 0.7], sundayClosesAt: 15, tipChance: 0.01, discountChance: 0.05,
    productBias: { menu: 3.2, bocata_tortilla: 1.4, mixto: 1.4, ensalada: 1.5, solo: 1.4, cortado: 1.3 },
  },
  {
    key: "lavapies", agentName: "TPV Lavapiés", label: "Horno Castizo · Lavapiés", lat: 40.4087, lng: -3.7005,
    ports: ["TPV-CAJA1"], baseDaily: 80, priceFactor: 0.94,
    weekday: [0.95, 0.88, 0.9, 0.95, 1.0, 1.18, 1.3],
    season: [["2026-07-01", 0.95], ["2026-08-05", 0.82], ["2026-08-24", 0.86], ["2026-09-08", 1.0], ["2026-10-20", 1.04]],
    dailyGrowth: 0.0035, slotBias: [0.8, 0.95, 1.4], sundayClosesAt: 15, tipChance: 0.01, discountChance: 0.06,
    productBias: { barra: 2.2, baguette: 2, bocata_tortilla: 1.8, empanada: 1.7, pastel_nata: 1.8, refresco: 1.4, tostada_tomate: 1.5, hogaza: 0.4, tostada_aguacate: 0.5, menu: 0.6 },
  },
];

/** Cortes y eventos pensados como "historias" para analizar en el dashboard. */
function dayEvents(branch: Branch, key: string, weekday: number): { factor: number; closed: boolean; promoCroissant: boolean } {
  let factor = 1;
  let closed = false;
  if (branch.key === "sol" && key === "2026-09-09") closed = true; // avería eléctrica: la sucursal no vende nada
  if (branch.key === "salamanca" && key >= "2026-08-10" && key <= "2026-08-16") closed = true; // vacaciones del local
  if (key === "2026-08-15") factor *= branch.key === "sol" ? 1.1 : 0.6; // Asunción (sábado festivo)
  if (key === "2026-10-12") factor *= branch.key === "sol" ? 1.28 : 0.72; // Fiesta Nacional
  if (key === "2026-09-01") factor *= branch.key === "sol" ? 1 : 1.12; // vuelta de vacaciones
  if (branch.key === "chamberi" && key === "2026-09-24") factor *= 0.4; // huelga de transporte
  const promoCroissant = (branch.key === "chamberi" || branch.key === "lavapies") && key >= "2026-09-14" && key <= "2026-09-20";
  if (promoCroissant) factor *= 1.1;
  void weekday;
  return { factor, closed, promoCroissant };
}

function seasonFactor(branch: Branch, key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  const here = dayNumber(y, m, d);
  const anchors = branch.season.map(([k, f]) => {
    const [ay, am, ad] = k.split("-").map(Number);
    return { day: dayNumber(ay, am, ad), f };
  });
  if (here <= anchors[0].day) return anchors[0].f;
  for (let i = 1; i < anchors.length; i++) {
    if (here <= anchors[i].day) {
      const span = anchors[i].day - anchors[i - 1].day;
      const t = (here - anchors[i - 1].day) / span;
      return anchors[i - 1].f + (anchors[i].f - anchors[i - 1].f) * t;
    }
  }
  return anchors[anchors.length - 1].f;
}

// ─────────────────────────────── generación ──────────────────────────────

interface Item { description: string; quantity: number; unitPrice: number; subtotal: number; voided?: boolean }
interface GeneratedTicket {
  ticketId: string;
  branch: Branch;
  port: string;
  capturedAt: string; // ISO UTC
  status: "parsed" | "needs_review" | "failed";
  parsedBy?: "deterministic" | "bedrock-fallback";
  items?: Item[];
  total?: number;
  tax?: number;
  discount?: number;
  tip?: number;
  failReason?: string;
}

/** Peso de cada hora local (7…21) en día laborable y en fin de semana. */
const HOUR_WEEKDAY = [0.04, 0.15, 0.12, 0.08, 0.06, 0.07, 0.12, 0.11, 0.05, 0.04, 0.06, 0.06, 0.04, 0.015, 0.003];
const HOUR_WEEKEND = [0.015, 0.06, 0.12, 0.14, 0.12, 0.1, 0.09, 0.08, 0.05, 0.05, 0.06, 0.06, 0.04, 0.02, 0.004];
const FIRST_HOUR = 7;

function slotOf(hour: number): 0 | 1 | 2 {
  return hour < 12 ? 0 : hour < 16 ? 1 : 2;
}

function buildTicket(rng: Rng, branch: Branch, key: string, hour: number, minute: number, weekday: number, promoCroissant: boolean): Omit<GeneratedTicket, "ticketId" | "branch" | "port" | "capturedAt" | "status"> & { items: Item[] } {
  const slot = slotOf(hour);
  const weekend = weekday === 0 || weekday === 6;

  const weight = (id: string, extra = 1): number => {
    const product = CATALOG[id];
    let w = (branch.productBias[id] ?? 1) * seasonality(id, key) * extra;
    if (product.category === "menu" && (weekend || hour < 12 || hour > 15)) w = 0;
    if (id === "croissant" && promoCroissant) w *= 2.6;
    return w;
  };
  const pickFrom = (ids: string[], extra: (id: string) => number = () => 1): Product | undefined => {
    const id = rng.weighted(ids, (candidate) => weight(candidate, extra(candidate)));
    return id ? CATALOG[id] : undefined;
  };

  const lines = new Map<string, number>();
  const add = (product: Product | undefined, quantity = 1) => {
    if (product) lines.set(product.id, (lines.get(product.id) ?? 0) + quantity);
  };

  const partyRoll = rng.next();
  const people = partyRoll < 0.7 ? 1 : partyRoll < 0.93 ? 2 : partyRoll < 0.985 ? 3 : 4;
  const kindRoll = rng.next();

  if (slot === 0) {
    if (kindRoll < 0.16) {
      // Compra rápida de pan para llevar.
      add(pickFrom(BREADS), rng.chance(0.2) ? 2 : 1);
      if (rng.chance(0.3)) add(pickFrom(["croissant", "napolitana", "palmera"]), rng.int(2, 6));
    } else {
      for (let p = 0; p < people; p++) {
        add(pickFrom(DRINKS_HOT));
        if (rng.chance(0.86)) add(pickFrom(BREAKFAST_FOOD));
        if (rng.chance(0.16)) add(pickFrom(["zumo", "agua"]));
      }
    }
  } else if (slot === 1) {
    if (!weekend && kindRoll < 0.34 && weight("menu") > 0) {
      for (let p = 0; p < people; p++) {
        add(CATALOG.menu);
        if (rng.chance(0.4)) add(pickFrom(["solo", "cortado", "leche"]));
      }
    } else if (kindRoll < 0.78) {
      for (let p = 0; p < people; p++) {
        add(pickFrom(LUNCH_FOOD.filter((id) => id !== "menu")));
        if (rng.chance(0.78)) add(pickFrom(DRINKS_COLD));
        if (rng.chance(0.22)) add(pickFrom(DRINKS_HOT));
      }
    } else if (kindRoll < 0.92) {
      add(pickFrom(BREADS), rng.chance(0.25) ? 2 : 1);
      if (rng.chance(0.4)) add(pickFrom(SWEETS));
    } else {
      add(pickFrom(GIFTS, (id) => (id === "tarta_entera" ? 0.4 : 1)));
    }
  } else {
    if (kindRoll < 0.2) {
      add(pickFrom(BREADS), rng.chance(0.25) ? 2 : 1);
      if (rng.chance(0.25)) add(pickFrom(["croissant", "napolitana"]), rng.int(1, 3));
    } else if (kindRoll < 0.3) {
      add(pickFrom(GIFTS, (id) => (id === "tarta_entera" ? 0.45 : 1)));
      if (rng.chance(0.3)) add(pickFrom(BREADS));
    } else {
      for (let p = 0; p < people; p++) {
        add(pickFrom([...DRINKS_HOT, "cana", "refresco", "horchata", "granizado"]));
        if (rng.chance(0.82)) add(pickFrom(SWEETS));
      }
    }
  }

  if (lines.size === 0) add(CATALOG.barra);

  const items: Item[] = [];
  for (const [id, quantity] of lines) {
    const product = CATALOG[id];
    const unitPrice = round2(Math.round((priceOn(product, key) * branch.priceFactor) / 0.05) * 0.05);
    items.push({ description: product.description, quantity, unitPrice, subtotal: round2(quantity * unitPrice) });
  }
  void minute;
  return { items };
}

function finalizeTicket(rng: Rng, branch: Branch, items: Item[], promoCroissant: boolean): { total: number; tax: number; discount?: number; tip?: number } {
  const itemsSum = round2(items.reduce((sum, item) => sum + item.subtotal, 0));
  let tax = 0;
  for (const item of items) {
    const product = Object.values(CATALOG).find((candidate) => candidate.description === item.description)!;
    tax += item.subtotal - item.subtotal / (1 + product.vat / 100);
  }
  let discount: number | undefined;
  const discountChance = promoCroissant ? branch.discountChance + 0.14 : branch.discountChance;
  if (rng.chance(discountChance)) {
    discount = round2(itemsSum * (rng.chance(0.7) ? 0.1 : 0.05));
    if (discount <= 0 || discount > itemsSum) discount = undefined;
  }
  let tip: number | undefined;
  if (rng.chance(branch.tipChance) && itemsSum > 8) tip = round2(rng.pick([0.5, 1, 1, 1.5, 2]));
  const total = round2(itemsSum - (discount ?? 0) + (tip ?? 0));
  return { total, tax: round2(tax), discount, tip };
}

const FAIL_REASONS = [
  "el parser \"example-38col\" no pudo extraer un ticket válido",
  "el documento no es una venta: es un reporte de caja (informe diario / cierre) con los totales por medio de pago",
  "el resultado del parseo no es económicamente coherente: el total no coincide con la suma de ítems",
];

function generateDay(branch: Branch, y: number, mo: number, d: number, now: Date): GeneratedTicket[] {
  const key = dateKey(y, mo, d);
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const rng = makeRng(`${branch.key}|${key}`);
  const events = dayEvents(branch, key, weekday);
  if (events.closed) return [];

  const daysSinceStart = dayNumber(y, mo, d) - dayNumber(2026, 7, 20);
  const growth = Math.pow(1 + branch.dailyGrowth, Math.max(0, daysSinceStart));
  const noise = 1 + rng.gauss() * 0.075;
  const expected = branch.baseDaily * branch.weekday[weekday] * seasonFactor(branch, key) * growth * events.factor * noise;
  const count = Math.max(0, Math.round(expected));

  const weekend = weekday === 0 || weekday === 6;
  const hourWeights = (weekend ? HOUR_WEEKEND : HOUR_WEEKDAY).map((w, i) => w * branch.slotBias[slotOf(FIRST_HOUR + i)]);
  const closeHour = weekday === 0 ? branch.sundayClosesAt : 21;

  const tickets: GeneratedTicket[] = [];
  for (let n = 0; n < count; n++) {
    const hour = rng.weighted(
      Array.from({ length: hourWeights.length }, (_, i) => FIRST_HOUR + i),
      (h) => (h < closeHour ? hourWeights[h - FIRST_HOUR] : 0),
    )!;
    const minute = rng.int(0, 59);
    const second = rng.int(0, 59);
    const captured = madridToUtc(y, mo, d, hour, minute, second);
    if (captured.getTime() > now.getTime()) continue;

    const ticketId = rng.uuid();
    const port = branch.ports.length > 1 ? rng.pick(branch.ports) : branch.ports[0];
    const outcome = rng.next();
    const base = { ticketId, branch, port, capturedAt: captured.toISOString() };

    if (outcome < 0.011) {
      tickets.push({ ...base, status: "failed", failReason: rng.pick(FAIL_REASONS) });
      continue;
    }
    const built = buildTicket(rng, branch, key, hour, minute, weekday, events.promoCroissant);
    const money = finalizeTicket(rng, branch, built.items, events.promoCroissant);
    const needsReview = outcome < 0.011 + 0.014 && key >= "2026-08-25";
    tickets.push({
      ...base,
      status: needsReview ? "needs_review" : "parsed",
      parsedBy: needsReview ? "bedrock-fallback" : "deterministic",
      items: built.items,
      ...money,
    });
  }
  return tickets;
}

function* eachLocalDay(from: Date, to: Date): Generator<[number, number, number]> {
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end) {
    yield [cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate()];
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

// ──────────────────────────────── escritura ──────────────────────────────

interface StackEnv {
  tickets: string; tenants: string; widgets: string; agents: string; codes: string;
  analyticsBucket: string; userPoolId: string;
}

function readStackEnv(): StackEnv {
  const raw = execFileSync(
    "aws",
    ["cloudformation", "describe-stacks", "--stack-name", STACK_NAME, "--region", REGION, "--query", "Stacks[0].Outputs", "--output", "json"],
    { encoding: "utf-8", shell: process.platform === "win32" },
  );
  const outputs = Object.fromEntries((JSON.parse(raw) as Array<{ OutputKey: string; OutputValue: string }>).map((o) => [o.OutputKey, o.OutputValue]));
  const need = (name: string) => {
    if (!outputs[name]) throw new Error(`el stack no tiene el output ${name}`);
    return outputs[name] as string;
  };
  return {
    tickets: need("TicketsTableName"), tenants: need("TenantsTableName"), widgets: need("WidgetsTableName"),
    agents: need("AgentsTableName"), codes: need("ActivationCodesTableName"),
    analyticsBucket: need("AnalyticsBucketName"), userPoolId: need("UserPoolId"),
  };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    }),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function ticketToDynamoItem(t: GeneratedTicket, agentIdByBranch: Map<string, string>): Record<string, unknown> {
  const agentId = agentIdByBranch.get(t.branch.key)!;
  const base = {
    tenantId: TENANT_ID,
    ticketId: t.ticketId,
    port: t.port,
    agentId,
    capturedAt: t.capturedAt,
    status: t.status,
    // Los crudos no se suben (el demo no necesita reparsear): la clave queda por consistencia del esquema.
    rawS3Key: `tenants/${TENANT_ID}/${t.ticketId}.txt`,
    rawKind: "text",
    ...ticketKey(TENANT_ID, t.capturedAt, t.ticketId),
    ...ticketStatusGsiKey(TENANT_ID, t.status, t.capturedAt),
  };
  // Un ticket parseado queda a pocos segundos de capturarse, como en producción.
  const parsedAt = new Date(new Date(t.capturedAt).getTime() + 4000).toISOString();
  if (t.status === "failed") return { ...base, parsedAt, failReason: t.failReason };
  return {
    ...base,
    parsedAt,
    items: t.items,
    total: t.total,
    tax: t.tax ?? null,
    discount: t.discount ?? null,
    tip: t.tip ?? null,
    parsedBy: t.parsedBy,
  };
}

function analyticsRows(t: GeneratedTicket, agentId: string): string[] {
  return (t.items ?? []).map((item) =>
    JSON.stringify({
      tenantId: TENANT_ID,
      ticketId: t.ticketId,
      capturedAt: t.capturedAt,
      port: t.port,
      agentId,
      status: t.status,
      parsedBy: t.parsedBy,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      voided: false,
      discount: t.discount ?? null,
      tip: t.tip ?? null,
      tax: t.tax ?? null,
      total: t.total,
    }),
  );
}

function monthPartition(capturedAt: string): { year: number; month: string } {
  const date = new Date(capturedAt);
  return { year: date.getUTCFullYear(), month: String(date.getUTCMonth() + 1).padStart(2, "0") };
}

// ───────────────────────────────── main ──────────────────────────────────

/** Mismos ids en cada corrida: volver a ejecutar el script sobrescribe en vez de duplicar. */
function demoAgentIds(): Map<string, string> {
  const rngAgents = makeRng("horno-castizo-agents");
  return new Map(BRANCHES.map((branch) => [branch.key, rngAgents.uuid()]));
}

/** Mismo formato y alfabeto que `generateActivationCode`, pero determinístico. */
function demoActivationCode(rng: Rng): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const group = () => Array.from({ length: 5 }, () => alphabet[rng.int(0, alphabet.length - 1)]).join("");
  return `${group()}-${group()}`;
}

/**
 * Los robots solo figuran "en línea" si su último latido tiene < 2 min. Estos son
 * ficticios (no hay PC detrás), así que este modo los mantiene vivos mientras
 * corra — se deja abierto durante la demo y se corta con Ctrl+C.
 */
async function heartbeatLoop(): Promise<never> {
  const env = readStackEnv();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const agentIds = [...demoAgentIds().values()];
  console.log(`Latido cada 45 s para ${agentIds.length} robots del demo. Ctrl+C para terminar.`);
  for (;;) {
    const now = new Date().toISOString();
    await Promise.all(agentIds.map((agentId) => ddb.send(new UpdateCommand({
      TableName: env.agents,
      Key: agentKey(TENANT_ID, agentId),
      UpdateExpression: "SET lastSeenAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":now": now },
    }))));
    console.log(`  ${now} latido enviado`);
    await new Promise((resolve) => setTimeout(resolve, 45_000));
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--heartbeat")) return heartbeatLoop();

  const from = new Date(UNTIL);
  from.setUTCMonth(from.getUTCMonth() - MONTHS);

  console.log(`Generando tickets de ${from.toISOString().slice(0, 10)} a ${UNTIL.toISOString().slice(0, 16)}Z …`);
  const all: GeneratedTicket[] = [];
  for (const [y, mo, d] of eachLocalDay(from, UNTIL)) {
    for (const branch of BRANCHES) all.push(...generateDay(branch, y, mo, d, UNTIL));
  }
  all.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

  // Resumen para validar las "historias" antes de escribir nada.
  const money = (n: number) => n.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  console.log(`\nTotal: ${all.length} tickets (${all.filter((t) => t.status === "parsed").length} parsed, ${all.filter((t) => t.status === "needs_review").length} needs_review, ${all.filter((t) => t.status === "failed").length} failed)`);
  const months = [...new Set(all.map((t) => t.capturedAt.slice(0, 7)))].sort();
  for (const branch of BRANCHES) {
    console.log(`\n${branch.label}`);
    for (const month of months) {
      const rows = all.filter((t) => t.branch === branch && t.capturedAt.startsWith(month) && t.status !== "failed");
      const sales = rows.reduce((sum, t) => sum + (t.total ?? 0), 0);
      console.log(`  ${month}  ${String(rows.length).padStart(5)} tickets   ${money(sales).padStart(8)} €   ticket medio ${(rows.length ? sales / rows.length : 0).toFixed(2)} €`);
    }
  }
  const grand = all.filter((t) => t.status !== "failed").reduce((sum, t) => sum + (t.total ?? 0), 0);
  console.log(`\nVentas totales: ${money(grand)} €`);

  if (!APPLY) {
    console.log("\n(corrida en seco — nada se escribió. Usá --apply para cargar a AWS.)");
    return;
  }

  const env = readStackEnv();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({ region: REGION });
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const nowIso = new Date().toISOString();

  // 1) Tenant — el onboarding va completo para que el demo abra directo en el dashboard.
  const created = new Date(from.getTime() - 2 * 86400000).toISOString();
  await ddb.send(new PutCommand({
    TableName: env.tenants,
    Item: {
      pk: `TENANT#${TENANT_ID}`,
      tenantId: TENANT_ID,
      businessName: BUSINESS_NAME,
      parserId: "example-38col",
      portParsers: {},
      createdAt: created,
      onboarding: { version: 1, startedAt: created, completedAt: created, productTourCompletedAt: created, starterDashboardCreatedAt: created },
    },
  }));
  console.log("\nTenant escrito.");

  // 2) Usuario de Cognito (si ya existe se conserva: no se pisa la contraseña).
  const password = `Horno-${randomBytes(5).toString("hex")}-Dm26!`;
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: env.userPoolId,
      Username: LOGIN_EMAIL,
      UserAttributes: [
        { Name: "email", Value: LOGIN_EMAIL },
        { Name: "email_verified", Value: "true" },
        { Name: "custom:tenantId", Value: TENANT_ID },
      ],
      MessageAction: "SUPPRESS",
    }));
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: env.userPoolId, Username: LOGIN_EMAIL, Password: password, Permanent: true }));
    writeFileSync(CREDENTIALS_FILE, `Horno Castizo (DEMO)\nemail:    ${LOGIN_EMAIL}\npassword: ${password}\ntenantId: ${TENANT_ID}\n`, "utf-8");
    console.log(`Usuario de Cognito creado. Credenciales guardadas en ${CREDENTIALS_FILE}`);
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) throw err;
    console.log("El usuario de Cognito ya existía — se conserva (credenciales sin cambios).");
  }

  // 3) Agentes (uno por sucursal) y códigos de activación.
  const agentIdByBranch = demoAgentIds();
  const rngCodes = makeRng("horno-castizo-codes");
  for (const branch of BRANCHES) {
    const agentId = agentIdByBranch.get(branch.key)!;
    const code = demoActivationCode(rngCodes);
    await ddb.send(new PutCommand({
      TableName: env.agents,
      Item: {
        tenantId: TENANT_ID, agentId, name: branch.agentName,
        apiKeyId: "demo-sin-api-key", // no hay API key real: estos robots son ficticios
        createdAt: created, lastSeenAt: nowIso, version: "0.3.0",
        location: { label: branch.label, city: "Madrid", lat: branch.lat, lng: branch.lng },
        ...agentKey(TENANT_ID, agentId),
      },
    }));
    await ddb.send(new PutCommand({
      TableName: env.codes,
      Item: { pk: `CODE#${code}`, tenantId: TENANT_ID, code, status: "used", createdAt: created, usedAt: created, agentId },
    }));
  }
  const spare = demoActivationCode(rngCodes);
  await ddb.send(new PutCommand({
    TableName: env.codes,
    Item: { pk: `CODE#${spare}`, tenantId: TENANT_ID, code: spare, status: "unused", createdAt: created },
  }));
  console.log("Agentes (4) y códigos de activación (5) escritos.");

  // 4) Widgets del dashboard inicial.
  const widgets = [
    { name: "Ventas totales", visualization: "kpi", metric: { field: "total", aggregation: "sum" } },
    { name: "Tickets procesados", visualization: "kpi", metric: { field: "event_count", aggregation: "count" } },
    { name: "Ticket medio", visualization: "kpi", metric: { field: "total", aggregation: "avg" } },
    { name: "Evolución de ventas", visualization: "line", metric: { field: "total", aggregation: "sum" }, groupBy: "day" },
    { name: "Ventas por sucursal", visualization: "bar", metric: { field: "total", aggregation: "sum" }, groupBy: "agent" },
    { name: "Productos más vendidos", visualization: "donut", metric: { field: "quantity", aggregation: "sum" }, groupBy: "description" },
  ];
  const rngWidgets = makeRng("horno-castizo-widgets");
  for (const widget of widgets) {
    const widgetId = rngWidgets.uuid();
    await ddb.send(new PutCommand({
      TableName: env.widgets,
      Item: { tenantId: TENANT_ID, widgetId, createdAt: nowIso, ...widget, ...widgetKey(TENANT_ID, widgetId) },
    }));
  }
  console.log(`Widgets (${widgets.length}) escritos.`);

  // 5) Tickets en DynamoDB.
  const dynamoItems = all.map((t) => ticketToDynamoItem(t, agentIdByBranch));
  const batches = chunk(dynamoItems, 25);
  let done = 0;
  await runPool(batches, 10, async (batch) => {
    let pending: Array<{ PutRequest: { Item: Record<string, unknown> } }> = batch.map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length > 0; attempt++) {
      if (attempt > 8) throw new Error("DynamoDB: demasiados reintentos de BatchWrite");
      const result = await ddb.send(new BatchWriteCommand({ RequestItems: { [env.tickets]: pending } }));
      pending = (result.UnprocessedItems?.[env.tickets] as typeof pending | undefined) ?? [];
      if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
    }
    done += batch.length;
    if (done % 5000 < 25) console.log(`  DynamoDB: ${done}/${dynamoItems.length} tickets`);
  });
  console.log(`Tickets en DynamoDB: ${done}.`);

  // 6) Filas de analítica en S3.
  const files = new Map<string, string[]>();
  for (const t of all) {
    if (t.status === "failed") continue;
    const { year, month } = monthPartition(t.capturedAt);
    const agentId = agentIdByBranch.get(t.branch.key)!;
    const prefix = `tenant=${TENANT_ID}/year=${year}/month=${month}`;
    // needs_review: archivo individual con la clave exacta de `analyticsRowKey` (revisión/descarte lo usan).
    const key = t.status === "needs_review" ? `${prefix}/${t.ticketId}.jsonl` : `${prefix}/demo-${t.branch.key}-${t.capturedAt.slice(0, 10)}.jsonl`;
    const rows = files.get(key) ?? [];
    rows.push(...analyticsRows(t, agentId));
    files.set(key, rows);
  }
  const entries = [...files.entries()];
  let written = 0;
  await runPool(entries, 16, async ([Key, rows]) => {
    await s3.send(new PutObjectCommand({ Bucket: env.analyticsBucket, Key, Body: rows.join("\n") + "\n", ContentType: "application/x-ndjson" }));
    written++;
  });
  console.log(`Archivos de analítica en S3: ${written}.`);
  console.log("\nListo. Para borrar todo el demo: `npx tsx scripts/delete-tenant.ts` con este tenantId:", TENANT_ID);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
