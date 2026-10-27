# Plantillas de WhatsApp de Gastia

Fuera de las 24 h desde el último mensaje del usuario, Meta solo permite enviar **plantillas aprobadas**.
Gastia lo decide solo: si el usuario escribió en las últimas 24 h manda texto/imagen libre; si no, usa la plantilla.

Crear en **Meta Business Manager → WhatsApp Manager → Plantillas de mensajes → Crear plantilla**.
Categoría: **Utilidad (Utility)**. Idioma: **Español (es)**. Los nombres deben coincidir con las variables de entorno
(`WHATSAPP_TEMPLATE_WEEKLY`, `WHATSAPP_TEMPLATE_DAILY`, `WHATSAPP_TEMPLATE_LANG`; valores por defecto abajo).

## Qué plan recibe qué
- **Básico:** solo el resumen semanal (domingo 8:00 p. m.). Sin chat (0 respuestas al mes).
- **Pro:** resumen diario fijo a las 9:00 a. m. (Lima), con el día anterior completo + semanal. Hasta 20 mensajes al mes entre respuestas del chat y alertas.
- **Unlimited:** igual que Pro, sin tope, y puede apagar el diario.
- No cuentan para el tope: resúmenes programados, código de verificación, bienvenida y el aviso de límite alcanzado.
- `SUNDAY_MERGE_DAILY_INTO_WEEKLY=true` hace que el domingo solo salga el semanal.

## 1. `gastia_resumen_semanal` (Básico, Pro y Unlimited)
- **Encabezado**: Imagen (ejemplo: cualquier PNG del reporte semanal).
- **Cuerpo**:

```
Hola {{1}}, soy {{2}}. Este es tu resumen semanal ({{3}}): gastaste {{4}} y tu categoría con más gasto fue {{5}}. Tienes {{6}} movimientos pendientes de confirmar. Revisa el detalle en tu dashboard de Gastia.
```
- **Botones**: ninguno (el Básico no tiene chat, y un botón de respuesta rápida generaría una respuesta del bot). Cuando exista el dominio definitivo se puede agregar un botón de enlace `Ver en Gastia`.
- **Ejemplos de variables**: {{1}} Javier · {{2}} Pipo 🐶, tu mascota de Gastia · {{3}} 5 - 11 oct · {{4}} S/ 320.50 · {{5}} Alimentación · {{6}} 3
- {{2}} es la mascota del usuario; sin mascota dice "Gastia" (queda "soy Gastia").

## 2. `gastia_resumen_diario` (Pro y Unlimited)
- **Sin encabezado.**
- **Cuerpo**:

```
Hola {{1}}, soy {{2}}. Ayer registraste {{3}} movimientos por {{4}} y tu categoría con más gasto fue {{5}}. Pendientes por confirmar: {{6}}. Avisos: {{7}}. Revisa el detalle en tu dashboard de Gastia.
```
- **Botones**: ninguno por ahora. Pendiente: cuando exista el dominio definitivo, agregar un botón de enlace `Ver pendientes` que abra el dashboard en "Por revisar" (mismo criterio que el `Ver en Gastia` del semanal).
- **Ejemplos de variables**: {{1}} Javier · {{2}} Pipo 🐶, tu mascota de Gastia · {{3}} 5 · {{4}} S/ 120.00 · {{5}} Alimentación · {{6}} 2 · {{7}} presupuesto de Alimentación al 80 %
- La variable {{7}} reúne en una línea las alertas que no pudieron enviarse antes por tener la ventana de 24 h cerrada; si no hay, dice "ninguno".

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
