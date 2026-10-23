# Setlist AI Studio · primera versión

Prototipo web instalable para probar la biblioteca y los setlists en Windows y Android. La biblioteca se guarda en SQLite local en `data/setlist.db`; al iniciar por primera vez, los datos del navegador actual se migran automáticamente. Los dispositivos que se conecten al mismo servidor local usan esa biblioteca. Todavía no hay cuenta ni base en la nube.

## Iniciar en Windows

1. Instala Node.js 22.5 o posterior si aún no está instalado.
2. Instala Python 3.10 o posterior y ejecuta `python -m pip install -r requirements.txt` (solo la primera vez).
3. Abre PowerShell en esta carpeta y ejecuta `npm install` (solo la primera vez).
4. Copia `.env.example` como `.env` y agrega tu clave de Groq. Las claves son opcionales para el respaldo local, pero necesarias para generar setlists con IA.
5. Ejecuta `npm start` y abre `http://localhost:4173` en Edge o Chrome. Desde el menú del navegador puedes instalar la aplicación.

## Probar en Android

1. Conecta la computadora y el teléfono a la misma red Wi-Fi.
2. Ejecuta `node server.mjs` en la computadora y averigua su dirección IPv4 local con `ipconfig`.
3. En Chrome para Android abre `http://DIRECCION-DE-LA-COMPUTADORA:4173` para probar la app en el teléfono.

Si Windows pregunta si permite conexiones en la red privada, permite el acceso para poder abrir el prototipo desde el teléfono. El navegador requiere HTTPS para instalar la PWA completa en Android; la prueba local por Wi-Fi sirve para probar el diseño y las funciones. La publicación con HTTPS será el siguiente paso para instalarla y probar el modo sin conexión.

## Qué incluye

- Biblioteca con búsqueda, categorías y edición manual de metadatos.
- Importación de listas por líneas, encabezados de categoría y detección de títulos duplicados antes de guardar.
- Edición manual de artista, género, subgénero, categoría, tipo de evento, energía y tonalidad.
- Generación de setlists con Groq a partir de la descripción y los metadatos guardados en SQLite; solo puede ordenar canciones existentes.
- Generador local de respaldo por duración, categoría y energía, con canciones únicas cuando Groq no está disponible.
- Setlists guardados con duración estimada, reordenamiento, eliminación y nueva propuesta basada en instrucciones.
- Diseño adaptable y modo instalable PWA.

Groq se usa únicamente al crear un setlist. La solicitud se ejecuta en Python, sin búsqueda web, y contiene un máximo de 120 canciones candidatas con sus metadatos locales compactos. El servidor lee los datos directamente de SQLite; la IA devuelve índices y el servidor los convierte a identificadores de canciones ya guardadas. La biblioteca no se envía para completar ni buscar metadatos faltantes. Si Groq falla, la app crea una propuesta con sus reglas locales.

La clave de Groq se carga desde `.env` mediante `GROQ_API_KEY`. Puedes configurar `GROQ_SETLIST_MODEL` (o reutilizar `GROQ_MODEL`). Las variables de LangSmith son opcionales y solo activan trazas si ya las usas. Nunca subas `.env`: está excluido de Git. Reinicia el servidor después de editarlo. La base SQLite se crea localmente en `data/setlist.db`, carpeta excluida de Git para no versionar tu repertorio.

La conexión usa el SDK oficial de Groq para Python (`groq_setlist.py`), salida JSON estructurada y esfuerzo de razonamiento bajo. La salida contiene solo índices de canciones y tiene un límite de tokens ajustado al tamaño del set.

## Si el setlist se genera demasiado rápido o no aparece uso en Groq

La app conserva un generador local como respaldo. Si el servidor activo aún no conoce `/api/setlist`, devolverá 404 y la app usará ese respaldo sin llamar a Groq. Detén el servidor anterior con `Ctrl+C` en su terminal, ejecuta `npm start` desde esta carpeta y recarga la app. Al generar un setlist, la consola del servidor debe mostrar `[Groq setlist] request ...` y, si Groq responde, `[Groq usage] ...`. Si aparece el aviso de respaldo, ahora también mostrará el error que causó el fallback.
