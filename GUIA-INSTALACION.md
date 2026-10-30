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
- Si la IA falla, la pregunta no se cuenta.
- Las funciones solo para Pro (foto del temario, guías e ideas para padres) se bloquean **en el servidor**, no solo en la app.
- El modelo de IA está en `MODEL` dentro de la misma función (Haiku, el más económico).

## Cobrar el plan Pro con link de pago o PayPal

1. Crea en tu pasarela (Wompi, tu banco o PayPal) un link de pago mensual y otro anual.
2. En la app, entra con tu cuenta de administrador (`ADMIN_EMAILS` en `functions/index.js`) → ⚙️ → **Abrir panel de administrador** → **Links y precios**. Pega los links y los precios y guarda.
3. La familia toca **Pagar Pro**, copia su código de familia, paga y lo pone en la referencia. Luego toca **Ya pagué: avisar**.
4. Te aparece en el panel → **Pagos**. Revisa en tu banco o PayPal que el pago llegó y toca **Activar 31 días** (o 365 si es anual). Los estudiantes reciben un aviso.
5. También puedes buscar una familia por su código en **Familias** y darle días (por ejemplo, 7 días de prueba o un año para una escuela) o quitarle el Pro.
6. El Pro vence solo. Si la familia paga antes de que venza, los días se suman. La app avisa 3 días antes.

Las familias ya no pueden activar Pro por su cuenta: solo el servidor (tu panel) puede cambiar el plan.

## Avatar, actividades asignadas y compañeros

- **Avatares:** el estudiante y la mamá o el papá eligen el suyo en ⚙️. Hay tres grupos: niños y niñas, adultos (mamá, papá, abuelos, maestros) con distintos tonos de piel, y divertidos (animales). El del estudiante se ve en la cabecera, el saludo, los grupos y la cuenta familiar; el de la familia, en su cabecera.
- **Tipos de actividad:** madre/padre → **Actividad** → **Tipos de actividades**. Los tipos personalizados aparecen al crear actividades en las dos cuentas.
- **Actividades asignadas:** madre/padre → **Actividad** → **Asignar actividad**. La fecha de entrega no puede ser anterior a hoy, y los recordatorios deben ser futuros y antes de la entrega. El estudiante la ve en **Tareas → Asignadas por mi familia** y solo puede marcarla como hecha.
- **Fecha de entrega y días que faltan:** cada actividad muestra a la derecha cuántos días faltan y la fecha. Se pone en amarillo cuando faltan 2 días o menos y en rojo cuando está vencida.
- **Recordatorios por actividad:** al crear o editar una actividad (la del estudiante o la que asigna madre/padre), en **🔔 Recordatorios** se agregan hasta 10 con fecha y hora. Se cambian en el mismo campo y se borran con ✕. Hay atajos: 3 días antes, 2 días antes, 1 día antes y el mismo día. Cada recordatorio debe ser antes de terminar el día de entrega, y los nuevos deben ser en el futuro.
- **Próximos recordatorios:** en Inicio el estudiante ve los de los próximos 7 días.
- **Avisos:** a la hora del recordatorio sale un aviso en pantalla. Si el estudiante toca **Activar avisos** y lo permite, también le llega una notificación del navegador. Solo funcionan con la app abierta o usada hace poco; con la app cerrada no están garantizados.
- **Compañeros de estudio:** solo entre estudiantes de la **misma familia**. Uno invita y el otro acepta.

## Validación de actividades del colegio (familia y docentes)

Cada actividad tiene un nivel de confianza: 🟡 **marcada por el estudiante** → 🔵 **vista por la familia** → 🟢 **confirmada por el docente** (o ❌ si no se hizo). Las que la familia o el docente marcan como no hechas no suman puntos en Retos.

- **Evidencia:** al marcar una actividad como hecha, el estudiante puede subir una foto del cuaderno o la hoja y escribir qué hizo. La foto se reduce para que pese poco y solo la ve la familia.
- **Revisión de la familia:** en **Actividad**, al tocar una actividad se abre su detalle con la evidencia. La familia pone **✔ La vi** o **✘ No la hizo**. En **Resumen**, la tarjeta **Validación de actividades** muestra los números de la semana y elige 3 actividades al azar para revisar. El estudiante no sabe cuáles.
- **Link para el docente:** desde el detalle, **Pedir confirmación al docente** crea un link único que se envía por WhatsApp o se copia. El docente lo abre sin cuenta, ve solo el primer nombre del estudiante y la actividad, y toca **Entregó / Tarde / No entregó**, con un comentario opcional. La familia ve la respuesta enseguida. El link vence en 7 días. Cada familia puede crear hasta 40 links por día.
- **Privacidad:** el link solo se guarda en el celular de quien lo creó, no en los datos que puede ver el estudiante. Así el estudiante no puede responder como si fuera el docente.

## Recordatorios de la familia y tareas de la casa

- **Entregas más próximas** (familia → Resumen): lista las entregas pendientes del estudiante en las próximas 2 semanas, ordenadas por fecha, con los días que faltan. Con 🔔 se envía un recordatorio **ahora** o **programado** para una fecha y hora (antes de terminar el día de entrega; si ya está vencida, dentro de los 7 días siguientes). **Recordar todas** manda uno con la lista de la semana. Los programados se pueden cancelar, y el estudiante los ve justo a su hora, con aviso.
- **Tareas de la casa** (sección **Casa**, para familia y estudiante): madre o padre crea rutinas de tres tipos: 🏠 **Casa** (basura, cuarto, platos…), 🧍 **Personal** (bañarse, cepillarse, leer…) y ⏰ **Rutina diaria** (levantarse a tiempo, preparar la mochila…). Cada una tiene ícono, días, hora de aviso y puntos (5, 10, 15 o 20). El estudiante la marca al terminarla y recibe un aviso a la hora elegida.
- **Revisión del día** (familia → Casa): muestra lo que tocaba hoy o ayer y lo que el estudiante marcó. La familia confirma **✔ Sí** o **✘ No** en cada una; solo suman puntos las confirmadas. Después toca de 5 p. m. en adelante aparece un aviso en Resumen para revisar.
- **Evaluación:** con base en el porcentaje confirmado se sugiere un estado, que la familia puede cambiar: 🌟 ¡Excelente trabajo! (90 % o más) · 👏 Muy buen trabajo (75 %) · 💪 ¡Por poco lo logras! (50 %) · 🌱 Necesita mejorar (25 %) · 🤝 Hoy no se logró: hablemos. Trae un mensaje sugerido que se puede editar y consejos para evaluar de forma educativa. El estudiante la recibe como mensaje y la ve en su sección Casa con los puntos. La semana se ve en cuadritos: verde = confirmada, verde claro = marcada sin revisar, rojo = no la hizo.

## Retos con compañeros (grupos de estudio entre familias)

En el menú del estudiante está **Retos** (🏆). Ahí:
- **Crear grupo** y **Invitar**: código de 7 caracteres, botón para copiar la invitación y otro para enviarla por WhatsApp.
- **Ranking semanal por puntos:** cada tarea completada vale 10, cada minuto de estudio 1 y cada día de racha 5. Se reinicia cada lunes.
- **Lugares:** 🥇🥈🥉 para los primeros. Cada estudiante ve en qué lugar va y cuántos puntos le faltan para pasar al de arriba.
- **Reto para el último lugar:** el creador del grupo lo escribe o elige una idea. El que va último aparece marcado con «🎯 Reto».
- En **Inicio** sale un resumen con tu lugar en cada grupo.


Cómo funciona:
1. Un estudiante crea un grupo y recibe un código de 7 caracteres. Él es el creador.
2. Otro estudiante, de cualquier familia, toca **Unirme con código**.
3. Su madre o padre ve la solicitud en **Resumen** y toca **Autorizar** o **Rechazar**.
4. El creador del grupo ve «Su familia ya autorizó» y toca **Aceptar**.
5. Cuando el estudiante abre la app, entra al ranking del grupo.

Qué se comparte: solo nombre, avatar, grado, puntos, tareas completadas, racha y minutos de estudio de los últimos 7 días. **Nunca** notas, tareas, mensajes ni datos de la familia.
Puntos = tareas completadas × 10 + minutos de estudio (7 días) + racha × 5.

Otros controles:
- La madre o el padre puede **Retirar permiso** en cualquier momento: el estudiante sale del grupo y deja de compartir.
- El creador puede quitar miembros o eliminar el grupo.
- El estudiante puede salir o cancelar su solicitud.
- Todo esto lo validan también las reglas de Firestore: nadie entra sin las dos aprobaciones, y cada estudiante solo puede escribir su propio resumen.

### Prueba recomendada con dos familias
1. Familia A: un estudiante crea el grupo y copia el código.
2. Familia B: el estudiante pide unirse con el código y ve «Esperando que tu mamá o papá autorice».
3. Familia B, madre/padre: en **Resumen** toca **Autorizar**.
4. Familia A, estudiante: toca **Actualizar** y luego **Aceptar**.
5. Familia B, estudiante: toca **Actualizar**. Ya debe salir en el ranking.
6. Familia B, madre/padre: toca **Retirar permiso**. El estudiante debe desaparecer del ranking.

## Colegios (administrador, docentes, enfermería y alumnos)

Esta versión agrega una función nueva en el servidor (`school`) y reglas nuevas. Hay que publicar las dos (paso 6) **y** subir la app a GitHub.

**Quién hace qué**
1. **Tú (plataforma):** ⚙️ → **Cambiar de panel** → **Plataforma StudyFlow** → **+ Registrar colegio**. Escribes nombre, responsable, teléfono, dirección, cupos de alumnos, fecha de vencimiento, los grados que ofrece y el **correo del administrador del colegio**.
   - Si además escribes una **contraseña inicial**, la cuenta queda creada: el colegio entra con **Entrar** (correo y contraseña) y la cambia en ⚙️ → **Cambiar contraseña**. Para restablecerla: Plataforma → **Editar** → «Acceso del administrador».
2. **Administrador del colegio:** entra con su correo y contraseña (o con Google y acepta la invitación). Desde su panel:
   - **Colegio:** perfil, horario y el **código del colegio** para las familias.
   - **Grados:** grados, secciones, materias y el docente de cada materia.
   - **Personal:** dirección, administración, enfermería y docentes. Con «Dar acceso» y una **contraseña inicial**, cada persona entra con su correo y esa contraseña (luego la cambia en ⚙️). Si olvida su contraseña, el administrador escribe una nueva en su ficha.
   - **Calendario:** tareas, exámenes, proyectos, temas de clase, eventos y avisos por grado.
   - **Alumnos:** aprobar o rechazar solicitudes, cambiar de grado o quitar alumnos.
3. **Docentes:** ven solo sus grados y agregan al calendario de sus materias.
4. **Enfermería:** envía avisos a la familia («Pasó a enfermería», «Se sintió mal»…). La familia los ve en su Resumen.
5. **Estudiante:** en Inicio toca **Conectar con mi colegio**, escribe el código y elige su grado. Cuando el colegio lo aprueba, sus materias, tareas y exámenes aparecen solos en su calendario. Él puede agregar recordatorios, retos y todo lo demás.

**Bueno saber**
- Los alumnos aprobados de un colegio con licencia vigente (y su familia) tienen las funciones **Pro** sin pagar aparte.
- Si cambias el código del colegio, el anterior deja de servir solo para solicitudes nuevas.
- El colegio ve solo lo escolar de cada alumno (tareas del colegio, notas registradas, estudio y temas); nunca mensajes, premios ni tareas de la casa.
- Una persona puede ser padre y docente a la vez: cambia de panel desde ⚙️.

## Temario (lo carga el docente)

En el panel del docente → **Mis materias** → elige la materia y el grado → sección **📚 Temario**:
- **Cargar temario:** pega un tema por línea, elige la semana de inicio y cuántos temas por semana. La app los reparte.
- **+ Un tema:** agrega uno solo. Toca cualquier tema para corregirlo o borrarlo.
- Los alumnos los ven en su temario semana por semana, listos para estudiarlos con el tutor de IA y hacer mini exámenes.

### Actividades de cada tema
- **Docente:** en el Temario toca un tema → **＋ Actividad para este tema**. La tarea, examen o actividad queda ligada al tema y les llega a los alumnos.
- **Estudiante:** en Estudiar → Temario (o dentro de cada materia) toca un tema: ve sus actividades y puede **agregar las suyas**.
- **Familia:** en Actividad aparece **📚 Temario** con lo de esta semana y las dos siguientes; toca **＋** junto a un tema para asignarle una actividad.
- Cada actividad muestra «📚 nombre del tema».

## Tipos de actividad

- **Familia:** la lista de tipos ya no aparece en la pantalla de Actividad. Al agregar una actividad, junto a «Tipo» toca **＋ Nuevo tipo** para crear uno (por ejemplo «Guía de trabajo»).
- **Docente y administración:** al agregar al calendario, toca **＋ Nuevo tipo**, elige un ícono y escribe el nombre (por ejemplo «🔬 Laboratorio»). Queda disponible para todo el colegio y les llega a los alumnos como una actividad más.

## Rendimiento académico (colegio, docente, familia y estudiante)

- **Colegio → Dashboard:** promedio del colegio y de cada grado, entregas a tiempo, vencidas, estudio por semana, materias con más dificultad, alumnos que necesitan apoyo, actividades publicadas por docente y alumnos sin actividad. Toca un grado para ver cada materia y cada alumno.
- **Docente → Mis materias:** por cada materia y grado: promedio, entregas a tiempo, vencidas, temas difíciles, la tabla de alumnos (en rojo quien necesita apoyo) y sus actividades próximas.
- **Familia (Resumen) y estudiante (Progreso):** «Boletín del colegio» con promedio, entregas a tiempo, pendientes, vencidas y temas por reforzar de cada materia.
- El colegio solo recibe lo escolar de cada alumno (tareas del colegio, notas registradas, estudio y temas). Nunca tareas de la casa, mensajes ni premios de la familia. Los datos se actualizan cuando el alumno abre la app.

## Dashboard de la plataforma

Solo para tu cuenta: ⚙️ → **Cambiar de panel** → **Plataforma StudyFlow** → **Dashboard**. Muestra familias, estudiantes, padres, colegios y su personal, uso de la app (actividades, entregas a tiempo, recordatorios, estudio), quién agrega las actividades, uso y costo de la IA, pagos y Pro, licencias por vencer, avisos de enfermería y grupos de retos. Toca **Actualizar** para traer los números del momento.

## Quién agregó cada actividad y cambios de la familia

- Cada actividad muestra su origen: 🧑‍🏫 docente (con su nombre), 👨‍👩‍👧 familia o 🧑‍🎓 estudiante.
- La familia, en **Actividad**, puede **agregar** actividades, **corregir** o **eliminar** las que se crearon por error y ponerles **recordatorios con fecha y hora** (también a las del colegio). Al estudiante le llegan con el aviso «Tu familia te recuerda».
- Las actividades del colegio solo las cambia o borra el docente desde su calendario; el cambio les llega solo a los alumnos.

## Si algo falla

| Problema | Solución |
|---|---|
| La app dice «Falta conectar Firebase» | Revisa `firebase-config.js`: el `apiKey` debe ser el tuyo y el archivo debe estar subido a GitHub |
| «Continuar con Google» no hace nada | Agrega `TUUSUARIO.github.io` en Authentication → Dominios autorizados (paso 3) |
| «No tienes permiso para guardar» | No se publicaron las reglas: repite el paso 6 |
| El tutor dice «No se pudo conectar con la IA» | Revisa que la función esté publicada, que el secreto exista y que tengas crédito en console.anthropic.com. En Firebase → Functions → Registros verás el detalle del error |
| «Ese código de familia no existe» | Copia el código desde ⚙️ → «Ver código de familia»; son 6 letras y números, sin espacios |
| «No tienes permiso» en el panel del colegio, o el docente no ve su invitación | Publica otra vez reglas y funciones (paso 6). El docente debe entrar con el **mismo correo** que registró el colegio; si entra con correo y contraseña, primero debe confirmar su correo |
| No veo los cambios nuevos | Cierra la app por completo y vuelve a abrirla |

## Costos aproximados en la prueba

- GitHub Pages: gratis.
- Firebase (cuentas, base de datos y funciones): gratis con poco uso dentro del plan Blaze.
- IA con Haiku: menos de un centavo por pregunta. Una familia muy activa gasta unos centavos al mes.

## Varias secciones del mismo grado (A, B, C…)
- Cuando la docente carga un temario, una tarea, un examen o cualquier actividad, la app muestra «Publicar en estas secciones» con todas las secciones de ese grado donde ella da esa materia, ya marcadas.
- Con una sola carga se guarda en todas. Si una sección va distinta (otra fecha, por ejemplo), se desmarca o se edita después solo en esa sección.
- Si la actividad está ligada a un tema, en cada sección queda ligada al mismo tema de esa sección.
- Al editar o eliminar algo, el cambio aplica solo a la sección donde se hace.

## Temario: Trimestre › Unidad › Temas
- El colegio, en «Temario», elige grado y materia y define por trimestre sus unidades y temas, sin fechas. Se guarda una sola vez para todas las secciones (A, B, C…).
- «+ Unidad»: trimestre, número, nombre y los temas (uno por línea). «+ Tema» agrega un tema a una unidad. Tocar una unidad o un tema permite cambiarlo o eliminarlo en todas las secciones.
- «Cargar temario»: pegar o subir Word, Excel, PDF, CSV o texto. Se reconocen líneas como «Trimestre 2», «Segundo trimestre», «Unidad 3: Ecuaciones» o «UNIDAD III - Ecuaciones»; las líneas de abajo son los temas de esa unidad. Los temas repetidos no se duplican.
- El colegio marca el trimestre en curso («Marcar como trimestre en curso») y si el año tiene 3 trimestres o 4 periodos.
- La docente, en «Mis materias», ve el temario por trimestre. Con «📅 Fechas» pone la fecha de cada tema de una unidad (o las reparte automáticamente) y la app calcula del primer al último tema cuánto dura la unidad. Puede poner la misma fecha en sus otras secciones.
- Al asignar una actividad (tarea, examen, laboratorio, revisión de cuaderno, exposición…), la liga a un tema y puede programar recordatorios para los alumnos (el mismo día, 1, 2, 3 días o 1 semana antes, a la hora que elija).
- Alumnos y familias ven en qué trimestre están, las unidades con sus temas y la unidad en curso de cada materia, con sus actividades. El alumno recibe los recordatorios de la docente («Tu docente te recuerda…»).
