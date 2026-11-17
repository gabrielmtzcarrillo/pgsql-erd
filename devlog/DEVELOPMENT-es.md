# Desarrollo

[English](DEVELOPMENT.md) · **Español**

Para quien trabaja en pgsql-erd: cómo ejecutarlo y probarlo, compilar los instaladores, agregar un idioma y dónde está
el código. Lo que hace la aplicación está en el [README](../README-es.md). Otras notas en esta carpeta (en inglés):

- [screenshots.md](screenshots.md): cómo se toman las capturas del README, y
  [screenshots-archive/](screenshots-archive/) con las que reemplazaron
- [pgerd-format.md](pgerd-format.md): el formato de archivo `.pgerd` y cómo lo lee y escribe la aplicación
- [ai-assistant.md](ai-assistant.md): el asistente de IA, desactivado en esta versión
- [import-blocks.md](import-blocks.md): cómo se hacen los bloques del diseñador de importación
- [excel_postgresql_import_designer_plan.md](excel_postgresql_import_designer_plan.md): el plan original del diseñador
  de importación

## Dónde va cada cosa

- **README.md / README-es.md** son para quien usa la aplicación: qué hace y cómo, con capturas. Mantén los dos
  idiomas al día.
- **devlog/** es para quien trabaja en el código (personas y agentes): compilar, probar, convenciones, la
  estructura del proyecto, formatos de archivo, notas de diseño y planes, cómo se toman las capturas y el archivo de
  capturas antiguas. Las notas técnicas nuevas van aquí, no en el README.
- **docs/** contiene lo que la aplicación publica: las capturas del README, la especificación de las plantillas de
  importación, su JSON Schema y los ejemplos.

## Convenciones de código

Las convenciones están en [DEVELOPMENT.md](DEVELOPMENT.md#coding-conventions) (en inglés): módulos CommonJS en el
proceso principal y ES en la página, todo acceso a archivos y a la base de datos por el puente de preload, todo
texto visible con `tr()` / `trn()` y traducido, valores como parámetros en el SQL, escrituras sujetas a la política
de la conexión y al registro de auditoría, pruebas con `node:test` y capturas hechas con
`scripts/capture-screenshots.mjs`.

## Ejecutar y probar

```bash
npm install
npm start                          # diagrama vacío
npm start -- samples/shop.pgerd    # abrir un archivo
npm test                           # pruebas unitarias
# pruebas de integración contra un servidor real (crea y elimina bases de datos temporales):
PGERD_TEST_HOST=127.0.0.1 PGERD_TEST_PORT=5432 PGERD_TEST_USER=postgres PGERD_TEST_PASSWORD=… npm test
```

Los iconos están en `src/renderer/icons.js`. Después de cambiarlos, ejecuta `npm run menu-icons` para volver a
generar los iconos PNG de los menús nativos en `src/main/menu-icons/`.

Para crear instaladores (AppImage/deb, NSIS, dmg) con la asociación de archivos `.pgerd`:

```bash
npm run dist
```

### Windows (.exe)

En Windows, con Node.js 20+ instalado, ejecuta desde la raíz del repositorio:

```bat
scripts\build-windows.bat
```

Es un archivo por lotes normal, así que se ejecuta desde el Símbolo del sistema o con doble clic, sin cambiar
la directiva de ejecución de PowerShell.

Instala las dependencias, ejecuta las pruebas y escribe en `dist\`:

| Archivo | Qué es |
| --- | --- |
| `pgsql-erd-Setup-<versión>.exe` | Instalador: permite elegir la carpeta de instalación, agrega accesos directos al menú Inicio y al escritorio y registra los archivos `.pgerd` |
| `pgsql-erd-<versión>-portable.exe` | Un solo ejecutable que funciona sin instalar |
| `win-unpacked\pgsql-erd.exe` | La aplicación sin empaquetar a partir de la que se crean los otros dos |

Para crear solo uno, pasa `installer`, `portable` o `dir` (por defecto `all`), p. ej.
`scripts\build-windows.bat portable`. Opciones: `--skip-tests`, `--skip-install`, `--clean` (elimina antes
`dist\`). Las mismas compilaciones están disponibles como scripts de npm: `npm run dist:win` (instalador +
portable), `dist:win:installer`, `dist:win:portable` y `dist:win:dir`.

La aplicación, el instalador y el desinstalador usan `build/icon.ico`. Los ejecutables no están firmados, así
que Windows SmartScreen avisa la primera vez que se ejecutan. Crearlos en Linux o macOS también funciona, pero
necesita [Wine](https://www.winehq.org/) (con soporte de 32 bits para el instalador).

## Estructura del proyecto

```
src/main/main.cjs         proceso principal de Electron: ventanas, menús, diálogos de archivos, E/S de archivos
src/main/db.cjs           conexión a PostgreSQL, introspección del catálogo, ejecución de migraciones (pg)
src/main/preload.cjs      API de contextBridge expuesta al renderer (window.erdHost)
src/main/ipc/             IPC para conexiones, scripts, consultas, pestañas de datos, el asistente, la auditoría
src/main/database/        conexiones y políticas por ventana, ejecución de la pestaña Consulta, consultas del
                          explorador de datos, grafos de Apache AGE (age.cjs)
src/main/scripting/       comprobación de tipos y transpilación (TypeScript), ejecución de scripts, la API de
                          base de datos de los scripts
src/main/ai/              proveedores (Ollama, compatibles con OpenAI, OpenAI), claves, herramientas, salida
                          estructurada
src/main/projects/        scripts y configuración en la carpeta del proyecto
src/runner/               el proceso aislado de los scripts
src/shared/               modelo del esquema, generador de tipos, permisos, constructor de contexto, esquema
                          JSON, datos ficticios, analizador de planes, utilidades de pgvector y Apache AGE
                          (usados por el proceso principal, el runner y la página)
src/shared/i18n.js        traducciones: tr(), trn(), selección del idioma
src/shared/locales/       catálogos de traducción (es.js)
src/renderer/index.html   estructura de la interfaz
src/renderer/app.js       dibujo, interacción, panel de propiedades, comandos
src/renderer/dbui.js      diálogos de conexión / importación / comparación
src/renderer/tabs.js      pestañas principales
src/renderer/workbench.js pestaña Scripts
src/renderer/query.js     pestaña Consulta
src/renderer/querybuilder.js pestaña Generador (generador visual de consultas)
src/renderer/dbtree.js    explorador de la base de datos
src/renderer/graph.js     pestaña Grafo (Apache AGE)
src/renderer/databrowser.js pestañas de datos y filtros
src/renderer/assistant.js pestaña Asistente y configuración de los proveedores de IA (desactivada, ver ai-assistant.md)
src/renderer/xlui.js      diálogo de importación de Excel / CSV, Entity Framework / JSON, SQLite y SQL Server
src/renderer/importdesigner.js pestañas Importación (diseñador de importación Excel -> PostgreSQL)
src/renderer/lib/pgerd.js lectura y escritura de .pgerd
src/renderer/lib/efimport.js lectores de Entity Framework Core (C#) y JSON para el diálogo de importación
src/renderer/lib/sqliteimport.js catálogo de SQLite -> especificaciones de tabla para el diálogo de importación
src/main/database/sqlite.cjs lee el esquema de un archivo SQLite (node:sqlite, solo lectura)
src/renderer/lib/mssqlimport.js catálogo de SQL Server y lector de scripts T-SQL -> especificaciones de tabla para el diálogo de importación
src/main/database/mssql.cjs lee el esquema de una base de datos SQL Server (mssql / tedious, solo lectura)
src/renderer/lib/mysqlimport.js catálogo de MySQL / MariaDB -> especificaciones de tabla para el diálogo de importación
src/shared/mysql-dump.js  lector de volcados de MySQL: instrucciones, CREATE TABLE, filas de INSERT
src/main/database/mysql.cjs lee el esquema de una base de datos MySQL / MariaDB (mysql2, solo lectura)
src/renderer/lib/oracleimport.js catálogo de Oracle -> especificaciones de tabla para el diálogo de importación
src/main/database/oracle.cjs lee un esquema de Oracle (node-oracledb en modo Thin, solo lectura)
src/renderer/lib/fktypes.js las columnas de clave foránea toman el tipo de la columna referenciada
src/renderer/copyui.js    «Copiar filas»: la opción del diálogo de importación y su progreso
src/main/database/data-copy.cjs copia filas de MySQL, SQL Server, Oracle, SQLite o un volcado a PostgreSQL
src/main/database/source-sheets.cjs tablas de una base de datos como hojas para el Diseñador de importación
src/renderer/lib/sql.js   generación de DDL de PostgreSQL
src/renderer/lib/layout.js geometría de las tablas, trazado de relaciones, organización automática
src/renderer/lib/catalog.js filas del catálogo -> modelo del diagrama
src/renderer/lib/diff.js  comparación entre base de datos y diagrama, y SQL de migración
src/renderer/lib/sync.js  importar / actualizar tablas del diagrama desde la base de datos
src/renderer/lib/spreadsheet.js lectura de .xlsx / CSV y conversión de hoja -> tabla
src/renderer/lib/highlight.js resaltado de sintaxis SQL
src/renderer/lib/querybuilder.js uniones y SELECT del generador de consultas
samples/shop.pgerd        diagrama de ejemplo
build/icon.svg            origen del icono de la aplicación; icon.ico (Windows) e icon.png se generan a partir de él
scripts/build-windows.bat script de compilación para Windows
scripts/capture-screenshots.mjs vuelve a tomar las capturas del README (ver devlog/screenshots.md)
tests/                    suites de node:test
```

El renderer se ejecuta en un sandbox con aislamiento de contexto y sin integración de Node. Todo el acceso a
archivos pasa por el puente de preload.

Una carpeta de proyecto tiene este aspecto; todo es texto plano y no se guarda ninguna contraseña ni clave de
API:

```
proyecto/
├── diagram.pgerd
├── pgsql-erd.json            configuración del proyecto (proveedor del asistente, modelo, permisos)
├── scripts/
│   ├── validators/*.ts
│   ├── generators/*.ts
│   └── migrations/*.ts
└── generated/database.d.ts   tipos para otros editores
```


## Agregar un idioma

El texto en inglés es la clave: el código llama a `tr('Save')` o a `trn(n, '{n} table', '{n} tables')`
(`src/shared/i18n.js`), y la página estática se traduce a partir de su texto al cargarse. Para agregar un
idioma:

1. Copia `src/shared/locales/es.js` en `src/shared/locales/<código>.js` y traduce los valores. Conserva los
   `{marcadores}` y los espacios al principio o al final.
2. Impórtalo en `src/shared/i18n.js` y agrégalo a `CATALOGS` y a `LOCALES` (el nombre que se muestra en
   Ver → Idioma, en su propio idioma).
3. Agrégalo a `CATALOGS` en `tests/i18n.test.js` y ejecuta `npm test`. La prueba lista cada texto usado en el
   código o en la página que falta en el catálogo, las entradas que ya no se usan y las traducciones cuyos
   marcadores no coinciden.

El texto nuevo de la interfaz pasa por `tr()` / `trn()` de la misma manera; la prueba falla hasta que cada
catálogo lo tenga.
