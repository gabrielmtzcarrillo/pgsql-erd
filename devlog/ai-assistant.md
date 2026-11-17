# AI assistant (disabled)

The AI assistant was turned off on 2026-11-11 (commit e8e149e, "Disable AI assistant and provider controls"). Its
code is still in the repository but not loaded:

- `src/main/ai/` (providers, assistant, tools, structured output) is not required by `src/main/ipc/workbench-ipc.cjs`,
  and the `ai-*` IPC handlers are commented out there.
- `src/renderer/assistant.js` is not imported by `src/renderer/app.js`; the **Assistant** tab, the **AI providers**
  dialog and the Query tab's **Ask assistant** button are commented out in `src/renderer/index.html`, and the
  **AI Assistant** / **AI Providers…** menu items in `src/main/main.cjs`.
- Scripts run without a provider, so `ai.chat()` and `ai.structured()` are not available to them, and the AI
  permission is left out of the script permissions dialog (`src/renderer/workbench.js`).

To bring it back, undo those comments. Below is how the README described the feature while it was on; the last
screenshot is [screenshots-archive/2026-10/assistant.png](screenshots-archive/2026-10/assistant.png).

## What it did

Chat with a model about the schema, and let it write scripts. It sees the tables selected in the diagram
or named in the question, their related tables, relationships and constraints, the current script and
the last validation errors — each can be switched off. With tools enabled it can look up tables, check a
script against the typings, validate SQL, and propose new scripts or changes; proposals open **unsaved**
in the editor, labelled with whether they type-check. Nothing the assistant writes runs by itself.

- **Providers:** Ollama, vLLM / LM Studio / llama.cpp / any OpenAI-compatible server, and OpenAI. Configure
  them in **AI setup**; the model list comes from the server. API keys are stored encrypted with the
  operating system's credential store (Electron `safeStorage`: Keychain, DPAPI, libsecret) and never reach the
  window; without a credential store they are kept in memory only. `OPENAI_API_KEY` is used when set.
- **Permissions** (saved in the project): read schema, read rows, run SELECT, create/modify scripts, run
  validators and dry runs. Writes and DDL are never available to the assistant.
- **Row data** is only sent when allowed (samples, query results, validator output); for remote providers
  you confirm it first, and the panel shows whether the conversation is *schema only* or includes data.
- **Structured output** (`ai.structured`) asks for JSON matching a JSON Schema (for a table, derived from
  its insertable columns), then checks JSON parsing, the schema, column types, NOT NULL and lengths, and sends
  the errors back to the model for a retry. Only valid values are returned to the script.

Scripts could also call the model:

- `ai.chat(prompt)`, `ai.structured({ table | schema, prompt })` (validated JSON), to generate data or review it
  (e.g. a validator that asks the model to flag suspicious values). They used the provider and model chosen in the
  Assistant tab; with a remote provider you confirmed before the first run that called `ai.*`, since the script may
  send it rows.
- The script permissions had an **AI** switch, on in every profile except Migration.
- The Query tab's **Ask assistant** sent the query, its plan and the hints to the Assistant tab.
- The audit log recorded assistant requests and whether they carried row data.

## En español

Conversa con un modelo sobre el esquema y deja que escriba scripts. Ve las tablas seleccionadas en el diagrama
o nombradas en la pregunta, sus tablas relacionadas, relaciones y restricciones, el script actual y los últimos
errores de validación; cada uno se puede desactivar. Con las herramientas activadas puede consultar tablas,
comprobar un script contra los tipos, validar SQL y proponer scripts nuevos o cambios; las propuestas se abren
**sin guardar** en el editor, indicando si pasan la comprobación de tipos. Nada de lo que escribe el asistente
se ejecuta por sí solo.

- **Proveedores:** Ollama, vLLM / LM Studio / llama.cpp / cualquier servidor compatible con OpenAI, y OpenAI.
  Se configuran en **Proveedores de IA**; la lista de modelos viene del servidor. Las claves de API se guardan
  cifradas con el almacén de credenciales del sistema operativo (`safeStorage` de Electron: Keychain, DPAPI,
  libsecret) y nunca llegan a la ventana; sin almacén de credenciales solo se guardan en memoria. Si está
  definida, se usa `OPENAI_API_KEY`.
- **Permisos** (guardados en el proyecto): leer el esquema, leer filas, ejecutar SELECT, crear/modificar
  scripts, ejecutar validadores y simulaciones. Las escrituras y el DDL nunca están disponibles para el
  asistente.
- **Los datos de filas** solo se envían si se permite (muestras, resultados de consultas, salida de
  validadores); con proveedores remotos lo confirmas antes, y el panel muestra si la conversación es de *solo
  esquema* o incluye datos.
- **Salida estructurada** (`ai.structured`) pide JSON que cumpla un JSON Schema (para una tabla, derivado de
  sus columnas insertables) y después comprueba el análisis del JSON, el esquema, los tipos de columna, NOT NULL
  y las longitudes, y devuelve los errores al modelo para que lo reintente. Al script solo le llegan valores
  válidos.
