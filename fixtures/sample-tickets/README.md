# Fixtures de tickets — SINTÉTICOS

Estos 5 archivos son ejemplos **generados**, no tickets reales de ningún
POS. Sirven para arrancar a diseñar/testear el parser (formato de líneas,
casos con descuento/propina/ítem anulado) mientras se consigue una muestra
real del negocio.

**Antes de dar el parser por terminado, hay que reemplazar (o al menos
validar contra) tickets reales** — el layout exacto (anchos, etiquetas,
si usa mayúsculas, cómo marca un anulado, etc.) va a depender 100% del
software de POS que use el negocio, y casi seguro no va a coincidir
exactamente con lo que se inventó acá.

| Archivo | Caso que cubre |
|---|---|
| `01-item-unico.txt` | Un solo producto |
| `02-multiples-items.txt` | Varios productos distintos |
| `03-con-descuento.txt` | Subtotal + descuento aplicado |
| `04-con-propina.txt` | Subtotal + propina sugerida |
| `05-item-anulado.txt` | Un ítem cancelado que no debe sumar al total |
