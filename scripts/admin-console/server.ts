// Consola local de operador: elegir un negocio y uno de sus agentes, pedirle un
// diagnóstico de solo lectura (PowerShell del catálogo del agente) y ver el
// resultado. Sirve para seguir el estado de las instalaciones sin pedir acceso
// remoto al cliente.
//
// Solo escucha en 127.0.0.1 y usa las credenciales de AWS de quien la corre
// (las mismas de los demás scripts de administración): no se publica ni lleva
// login propio. Los diagnósticos se escriben directo en la tabla Agents; el
// agente los recibe en su próximo heartbeat (hasta ~1 min) y devuelve la salida.
//
// Uso (desde ticket-parsing-cloud/):
//   npm run admin                      # http://localhost:4000
//   ADMIN_PORT=4100 npm run admin
//   AGENTS_TABLE=... TENANTS_TABLE=... # opcional; por defecto los lee del stack
import { createServer } from "node:http";
import { join } from "node:path";

import { createApp } from "./app.js";
import { connectAdminData } from "./aws.js";

const PORT = Number(process.env.ADMIN_PORT) || 4000;
const htmlPath = join(__dirname, "index.html");

const data = connectAdminData();
createServer(createApp(data, PORT, htmlPath)).listen(PORT, "127.0.0.1", () => {
  console.log(`Consola de operador en http://localhost:${PORT}  (Ctrl+C para cerrar)`);
});
