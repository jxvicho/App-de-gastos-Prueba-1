# Plantillas de WhatsApp de Gastia

Fuera de las 24 h desde el último mensaje del usuario, Meta solo permite enviar **plantillas aprobadas**.
Gastia lo decide solo: si el usuario escribió en las últimas 24 h manda texto/imagen libre; si no, usa la plantilla.

Crear en **Meta Business Manager → WhatsApp Manager → Plantillas de mensajes → Crear plantilla**.
Categoría: **Utilidad (Utility)**. Idioma: **Español (es)**. Los nombres deben coincidir con las variables de entorno
(`WHATSAPP_TEMPLATE_WEEKLY`, `WHATSAPP_TEMPLATE_DAILY`, `WHATSAPP_TEMPLATE_LANG`; valores por defecto abajo).

## 1. `gastia_resumen_semanal`
- **Encabezado**: Imagen (ejemplo: cualquier PNG del reporte semanal).
- **Cuerpo**:

```
Hola {{1}}, este es tu resumen semanal de Gastia ({{2}}). Gastaste {{3}} y tu categoría con más gasto fue {{4}}. Tienes {{5}} movimientos pendientes de confirmar. Toca un botón o escríbeme cuando quieras.
```
- **Botones (respuesta rápida)**: `Ver pendientes` · `Resumen del mes`
- **Ejemplos de variables**: {{1}} Javier · {{2}} 5 - 11 oct · {{3}} S/ 320.50 · {{4}} Alimentación · {{5}} 3

## 2. `gastia_resumen_diario`
- **Sin encabezado**.
- **Cuerpo**:

```
Hola {{1}}, este es tu resumen de hoy en Gastia. Gastaste {{2}} y tu categoría con más gasto fue {{3}}. Tienes {{4}} movimientos pendientes de confirmar. Escríbeme si quieres ver el detalle.
```
- **Botón (respuesta rápida)**: `Ver pendientes`
- **Ejemplos de variables**: {{1}} Javier · {{2}} S/ 45.00 · {{3}} Alimentación · {{4}} 2

## Reglas de Meta que ya cumple el código
- Ninguna variable al inicio ni al final del texto.
- Los valores de las variables no llevan saltos de línea, tabs ni 4+ espacios seguidos (se limpian automáticamente).
- Las variables vacías se reemplazan por "-" o "ninguna".
- Cuerpo de hasta 1024 caracteres.

## Botones de respuesta rápida
Al tocarlos, Meta envía un mensaje de tipo `button`. El webhook lo traduce: "Ver pendientes" → muestra los pendientes;
"Resumen del mes" → inicia el resumen mensual. Además, responder abre una nueva ventana de 24 h (texto libre y gratis).

## Costo
Las plantillas de utilidad se cobran por mensaje enviado fuera de la ventana de 24 h. Consulta la tarifa vigente para
Perú en la página de precios de WhatsApp Business Platform (cambia con el tiempo). Por eso el reporte diario no se envía
si ese día no hubo gastos ni pendientes.

## Probar
1. Crea y espera la aprobación de las 2 plantillas (suele tardar minutos).
2. Activa el reporte diario en Configuración y elige una hora.
3. Para probar la plantilla sin esperar: no escribas al bot durante 24 h (o borra la clave `wa:window:<número>` en Redis) y pide "resumen semanal".
