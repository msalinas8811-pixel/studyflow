# StudyFlow con GitHub + Firebase: guía de instalación

Esta guía es para dejar StudyFlow funcionando en internet, con cuentas de usuario, sincronización entre celulares y la IA. No necesitas saber programar: solo copiar, pegar y seguir los pasos en orden. Calcula entre 1 y 2 horas la primera vez.

## Qué hay en esta carpeta

| Carpeta / archivo | Para qué sirve | Dónde va |
|---|---|---|
| `app/` | La aplicación (lo que ven los usuarios) | Se sube a **GitHub Pages** |
| `app/firebase-config.js` | Los datos de tu proyecto de Firebase | Lo editas tú (paso 5) |
| `firebase/firestore.rules` | Reglas de seguridad: cada familia solo ve sus datos | Se publica en **Firebase** |
| `firebase/functions/` | La función `ai`: guarda tu llave de la IA y controla los límites | Se publica en **Firebase** |

Cómo funciona: los usuarios abren la app desde GitHub Pages. La app guarda los datos en Firebase (Firestore). Cuando alguien usa la IA, la app le pide la respuesta a tu función en Firebase. La función revisa el plan y los límites de esa familia y llama a Claude con tu llave. **La llave nunca está dentro de la app.**

---

## Paso 1. Cuenta de la API de Claude (la IA)

1. Entra a **console.anthropic.com** y crea una cuenta.
2. En **Billing**, agrega una tarjeta y compra crédito (con $5–10 alcanza de sobra para las pruebas).
3. En **Limits**, pon un **límite de gasto mensual** (por ejemplo $20). Así nunca te llega una factura sorpresa.
4. En **API Keys**, crea una llave llamada `studyflow`. Cópiala y guárdala en un lugar seguro: la usarás en el paso 6 y no se vuelve a mostrar.

## Paso 2. Proyecto de Firebase

1. Entra a **console.firebase.google.com** con tu cuenta de Google.
2. **Agregar proyecto** → nombre: `studyflow` (Firebase le agrega un código, por ejemplo `studyflow-a1b2c`; ese es el **ID del proyecto**).
3. Google Analytics: puedes desactivarlo.
4. Cambia al plan **Blaze** (abajo a la izquierda, «Actualizar»). Es obligatorio para las funciones, pero tiene una cuota gratis grande: en pruebas normalmente pagas $0.
5. Al activar Blaze, crea una **alerta de presupuesto** de $5 o $10.

## Paso 3. Cuentas de usuario (Authentication)

1. En el menú: **Compilación → Authentication → Comenzar**.
2. En **Método de acceso**, activa **Correo electrónico/contraseña**.
3. Activa también **Google** (elige tu correo como correo de asistencia).
4. En **Configuración → Dominios autorizados**, toca **Agregar dominio** y escribe `TUUSUARIO.github.io` (tu usuario de GitHub). Sin esto, el botón de Google no funciona desde tu página.

## Paso 4. Base de datos (Firestore)

1. **Compilación → Firestore Database → Crear base de datos**.
2. Ubicación: la más cercana (por ejemplo `nam5 (us-central)`).
3. Elige **modo de producción**. Las reglas correctas se publican en el paso 6.

## Paso 5. Conectar la app con tu proyecto

1. En Firebase: **⚙️ Configuración del proyecto → General → Tus apps → ícono `</>` (Web)**.
2. Nombre: `studyflow-web`. No marques Hosting. Toca **Registrar app**.
3. Aparece un bloque con `apiKey`, `authDomain`, `projectId`, etc.
4. Abre `app/firebase-config.js` con el Bloc de notas (o TextEdit) y reemplaza cada valor por el tuyo. Guarda.

Estos datos **no son secretos**: es normal que estén dentro de la app. La seguridad la dan las reglas.

## Paso 6. Publicar las reglas y la función de IA

Esto se hace una sola vez desde tu computadora.

1. Instala **Node.js** (versión LTS) desde **nodejs.org**.
2. Abre la **Terminal** (Mac) o **PowerShell** (Windows) y escribe:
   ```
   npm install -g firebase-tools
   firebase login
   ```
   Se abre el navegador para que entres con tu cuenta de Google.
3. Abre el archivo `firebase/.firebaserc` y cambia `ESCRIBE-AQUI-EL-ID-DE-TU-PROYECTO` por tu ID del paso 2. Guarda.
4. En la Terminal, entra a la carpeta `firebase` de este paquete. La forma fácil: escribe `cd ` (con espacio), arrastra la carpeta `firebase` a la ventana y presiona Enter.
5. Guarda tu llave de Claude como secreto (te la pedirá; pégala y presiona Enter):
   ```
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
6. Instala y publica:
   ```
   cd functions
   npm install
   cd ..
   firebase deploy --only firestore:rules,functions
   ```
7. Si al final dice **Deploy complete!**, listo.

## Paso 7. Subir la app a GitHub Pages

1. Crea una cuenta en **github.com** si no tienes.
2. **New repository** → nombre: `studyflow` → **Public** → **Create repository**.
3. Toca **uploading an existing file** y arrastra **todo lo que está dentro de la carpeta `app`** (no la carpeta en sí): `index.html`, `firebase.js`, `firebase-config.js`, `manifest.json`, `sw.js` y la carpeta `icons`. Toca **Commit changes**.
4. Ve a **Settings → Pages**. En «Branch», elige `main` y `/ (root)` → **Save**.
5. En uno o dos minutos tu app estará en `https://TUUSUARIO.github.io/studyflow/`.

## Paso 8. Probar en familia

1. Desde tu celular, abre el enlace → **Crear cuenta** → escribe tu nombre → **Crear mi familia**.
2. Aparece el **código de familia** (6 letras). También lo encuentras en ⚙️ → «Ver código de familia».
3. En el celular de tu hijo o hija: abre el mismo enlace → **Crear cuenta** con su propio correo → escribe el código → **Unirme a mi familia**.
4. Para instalarla como app: en Android, menú ⋮ → **Instalar app**; en iPhone, botón Compartir → **Agregar a pantalla de inicio**.
5. Otro padre o madre también puede unirse con el mismo código («Soy otro padre o madre»).

## Cómo actualizar la app más adelante

Cuando te envíe una versión nueva, en GitHub abre el repositorio → **Add file → Upload files** → arrastra el `index.html` nuevo → **Commit**. Los usuarios la reciben al volver a abrir la app. No vuelvas a subir `firebase-config.js` si ya tiene tus datos.

## Límites de la IA y plan Pro

- Los límites están al inicio de `firebase/functions/index.js` (`LIMITS`). Gratis: 5 preguntas al tutor por día y 2 mini exámenes por semana por estudiante. Pro: 50 y 30. Si los cambias, vuelve a ejecutar `firebase deploy --only functions`.
- Las funciones solo para Pro (foto del temario, guías e ideas para padres) se bloquean **en el servidor**, no solo en la app.
- **El plan Pro todavía es de prueba:** cualquier madre o padre lo activa con la verificación de adulto, sin pagar. Para cobrar de verdad, el siguiente paso es conectar la pasarela de pago (Wompi o PayPal) para que el plan se active solo cuando llegue el pago.
- Puedes ver el uso por familia en Firestore → `families` → la familia → `usage`.
- El modelo de IA está en `MODEL` dentro de la misma función (Haiku, el más económico).

## Si algo falla

| Problema | Solución |
|---|---|
| La app dice «Falta conectar Firebase» | Revisa `firebase-config.js`: el `apiKey` debe ser el tuyo y el archivo debe estar subido a GitHub |
| «Continuar con Google» no hace nada | Agrega `TUUSUARIO.github.io` en Authentication → Dominios autorizados (paso 3) |
| «No tienes permiso para guardar» | No se publicaron las reglas: repite el paso 6 |
| El tutor dice «No se pudo conectar con la IA» | Revisa que la función esté publicada, que el secreto exista y que tengas crédito en console.anthropic.com. En Firebase → Functions → Registros verás el detalle del error |
| «Ese código de familia no existe» | Copia el código desde ⚙️ → «Ver código de familia»; son 6 letras y números, sin espacios |
| No veo los cambios nuevos | Cierra la app por completo y vuelve a abrirla |

## Costos aproximados en la prueba

- GitHub Pages: gratis.
- Firebase (cuentas, base de datos y funciones): gratis con poco uso dentro del plan Blaze.
- IA con Haiku: menos de un centavo por pregunta. Una familia muy activa gasta unos centavos al mes.
