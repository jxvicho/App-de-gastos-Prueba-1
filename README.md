# Backend — App de gastos vía WhatsApp + correo

Fase 1 del proyecto: **modelo de datos + backend base**. Incluye:

- Modelo de datos completo en Prisma (`prisma/schema.prisma`) para usuarios, correos vinculados, bancos, tarjetas/cuentas, transacciones, categorías, presupuestos, pagos recurrentes, reglas, recordatorios y sesiones de WhatsApp.
- Servidor Express + TypeScript con auth propia (registro/login con JWT).
- CRUD funcional de categorías y transacciones, incluyendo el flujo de confirmar/rechazar que luego usará el bot de WhatsApp.
- Seed con categorías por defecto y catálogo inicial de bancos peruanos (BCP, Interbank, BBVA, Scotiabank, Yape, Plin, etc.).
- `docker-compose.yml` para levantar Postgres y Redis en local sin instalar nada a mano.

## Cómo correrlo

Hay dos formas. Si no tienes Node.js instalado, usa la **Opción A** — no necesitas instalar nada más que Docker Desktop.

### Opción A — Todo con Docker (no requiere tener Node.js instalado)

1. **Copiar variables de entorno:**
   ```bash
   cp .env.example .env
   ```
   No hace falta editar nada para esta fase.

2. **Levantar todo (backend + Postgres + Redis) con un solo comando:**
   ```bash
   docker compose up --build
   ```
   La primera vez tarda unos minutos (descarga las imágenes e instala dependencias dentro del contenedor). Vas a ver los logs de Postgres, Redis y del backend en la misma terminal. El backend automáticamente:
   - Espera a que Postgres esté listo
   - Crea las tablas (`prisma migrate deploy`)
   - Carga el catálogo de bancos (seed)
   - Arranca el servidor

   Cuando veas `✅ Backend corriendo en http://localhost:4000`, ya está listo.

   Para pararlo: `Ctrl+C`, y para volver a levantarlo después: `docker compose up` (ya no hace falta `--build`, solo la primera vez o cuando cambies `package.json`).

### Opción B — Con Node.js instalado localmente

1. **Levantar solo Postgres y Redis:**
   ```bash
   docker compose up -d postgres redis
   ```
2. **Copiar variables de entorno:** `cp .env.example .env`
3. **Instalar dependencias:** `npm install`
4. **Crear las tablas:** `npm run prisma:migrate` (te pedirá un nombre, ej. `init`)
5. **Cargar el catálogo de bancos:** `npm run prisma:seed`
6. **Arrancar el servidor:** `npm run dev`

## Probar que funciona

```bash
# Salud del servidor y la DB
curl http://localhost:4000/api/health

# Registrar un usuario (crea automáticamente sus 25 categorías por defecto)
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Javier","email":"javier@test.com","password":"12345678"}'

# Con el token que devuelve el registro:
curl http://localhost:4000/api/categories \
  -H "Authorization: Bearer TU_TOKEN_AQUI"
```

## Explorar la base de datos visualmente

```bash
npm run prisma:studio
```
Abre una interfaz web en `http://localhost:5555` para ver y editar los datos directamente — muy útil mientras desarrollamos.

## Decisiones de diseño clave

- **Los tokens OAuth (Gmail/Outlook) se encriptan con AES-256-GCM** antes de guardarse (`src/utils/crypto.ts`). Nunca se guardan en texto plano, ni siquiera en desarrollo.
- **Las transacciones tienen un campo `status`** (`PENDING_CONFIRMATION`, `CONFIRMED`, `REJECTED`, `AUTO_CONFIRMED`) que modela exactamente el flujo que viste en las capturas: el bot detecta el gasto, pregunta por WhatsApp, y el usuario confirma o lo ignora. Si el usuario activa "manos libres" (`WhatsappSession.isHandsFree`), se puede saltar la confirmación.
- **`extractionMeta` en `Transaction`** guarda el JSON crudo que devuelve el modelo de IA al leer el correo — sirve para auditar y mejorar el prompt de extracción más adelante, sin tener que re-parsear correos viejos.
- **`Rule`** modela las reglas personalizadas tipo "siempre que gaste en Starbucks, ponlo en Comida" que viste en la conversación de WhatsApp de ejemplo.

## Qué sigue (Fase 2)

Conectar Gmail API y Microsoft Graph API vía OAuth, más el listener de correos nuevos (`watch` de Gmail / suscripciones webhook de Graph) que dispara la extracción con IA y crea las transacciones en estado `PENDING_CONFIRMATION`.
