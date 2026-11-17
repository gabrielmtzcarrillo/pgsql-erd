# pgsql-erd

[English](README.md) · **Español**

Una herramienta de escritorio de diagramas ER (entidad–relación) y banco de trabajo de bases de datos para
PostgreSQL, hecha con Node.js y Electron. Abre y guarda **archivos `.pgerd` de pgAdmin 4**, así que los
diagramas pueden ir y venir entre la herramienta ERD de pgAdmin y esta aplicación. Además incluye scripts de
TypeScript que conocen el esquema (validadores, generadores de datos de prueba, migraciones) con simulaciones,
un analizador de consultas, un explorador de datos con filtros al estilo de Excel, grafos de Apache AGE e
importaciones desde Excel, Entity Framework, SQLite, SQL Server, MySQL / MariaDB y Oracle que también pueden
copiar las filas a PostgreSQL.

![Diagrama](docs/screenshots/es/diagram.png)

## Capturas de pantalla

### Cinta de opciones y pestañas

Los comandos se agrupan al estilo de Office (Archivo: Abrir, Guardar, Guardar como…; Base de datos: Conectar,
Explorador, Importar Excel, Diseñador de importación) con iconos a dos colores; los menús nativos usan los mismos
iconos. Debajo de la cinta están las pestañas: una ventana empieza con un diagrama, y los botones **+ Diagrama**,
**+ Scripts**, **+ Consulta**, **+ Generador**, **+ Importar**, **+ Grafo** y **+ Datos** abren tantas más como
quieras (**+ Diagrama** también es <kbd>Ctrl</kbd>+<kbd>N</kbd>). Abrir un archivo `.pgerd` lo muestra en una pestaña de diagrama propia (o en la
vacía con la que empezaste). **Guardar** y **Guardar como…** trabajan con la pestaña al frente: un diagrama
guarda su `.pgerd` (Guardar como también puede escribir SQL, SVG o PNG), las pestañas Consulta y Generador
guardan su SQL en un archivo `.sql`, una pestaña Scripts guarda su script en el proyecto (Guardar como escribe
su código en un archivo `.ts`) y una pestaña Grafo guarda su consulta Cypher en un archivo `.cypher`. La
pestaña Diagrama tiene su propia barra: **Deshacer**, **Rehacer**, **Tablas**,
**Tabla**, **Relación**, **Eliminar**, **Vista previa SQL**, **Importar desde la base de datos…** y **Comparar**.

![Cinta de opciones](docs/screenshots/es/ribbon.png)

### Barra lateral de la tabla

Selecciona una tabla para ver y editar sus propiedades, columnas y relaciones. Al hacer clic en una columna del diagrama se abre su editor.

![Barra lateral de la tabla](docs/screenshots/es/table-sidebar.png)

### Vista previa SQL

DDL de PostgreSQL en vivo con resaltado de sintaxis.

![Vista previa SQL](docs/screenshots/es/sql-preview.png)

### Relaciones

Agrega una clave foránea y, si quieres, crea también la columna. Arrastra desde el punto de una columna (la clave foránea) hasta una columna de otra tabla (la referenciada) para abrir el diálogo con ambas ya elegidas.

![Nueva relación](docs/screenshots/es/relationship.png)

### Temas

Blanco, Oscuro, Visual Studio y Windows ME en **Ver → Tema**, o el del sistema.

![Temas](docs/screenshots/es/themes.png)

### Explorador de la base de datos

Los esquemas, tablas y columnas de la base conectada; arrastra una tabla o haz doble clic en ella para agregarla al diagrama.

![Explorador de la base de datos](docs/screenshots/es/db-explorer.png)

### Generador de consultas

Agrega tablas desde el explorador y marca columnas; las tablas relacionadas se unen automáticamente.

![Generador de consultas](docs/screenshots/es/query-builder.png)

### Importar desde la base de datos

Elige las tablas que quieres agregar o actualiza las que ya están en el diagrama.

![Importar tablas](docs/screenshots/es/db-import.png)

### Importar desde Entity Framework / JSON

Lee las clases de entidad y el `DbContext` de un modelo de EF Core (o una descripción JSON) y agrega sus tablas al diagrama.

![Importar desde Entity Framework](docs/screenshots/es/ef-import.png)

### Importar desde SQLite

Lee las tablas de un archivo de base de datos SQLite y las agrega al diagrama como tablas de PostgreSQL.

![Importar desde SQLite](docs/screenshots/es/sqlite-import.png)

### Importar desde SQL Server

Lee las tablas de una base de datos Microsoft SQL Server, o de un script T-SQL, y las agrega al diagrama como tablas de PostgreSQL.

![Conectar a SQL Server](docs/screenshots/es/mssql-connect.png)

![Importar desde SQL Server](docs/screenshots/es/mssql-import.png)

### Importar desde MySQL / MariaDB y Oracle, y copiar las filas

Lee las tablas de una base de datos MySQL o MariaDB (o de un archivo de `mysqldump`) o de un esquema de Oracle, agrégalas
al diagrama y copia sus filas a la base de datos PostgreSQL conectada en una sola transacción. La misma copia funciona
desde SQL Server y SQLite.

![Importar desde MySQL](docs/screenshots/es/mysql-import.png)

![Copiar filas](docs/screenshots/es/copy-rows.png)

![Importar desde Oracle](docs/screenshots/es/oracle-import.png)

### Comparar / sincronizar

Las diferencias con la base de datos y el SQL de migración.

![Comparar con la base de datos](docs/screenshots/es/db-compare.png)

### Scripts

Validadores de TypeScript con tipos; al hacer clic en un error se muestra la fila.

![Scripts](docs/screenshots/es/scripts.png)

### Revisión antes de confirmar

Los cambios de una ejecución esperan en una transacción abierta hasta que los confirmas.

![Revisión antes de confirmar](docs/screenshots/es/commit-review.png)

### Analizador de consultas

EXPLAIN ANALYZE como árbol, con el tiempo de cada nodo y sugerencias de índices.

![Plan de consulta](docs/screenshots/es/query-plan.png)

### Pestañas de datos

Filtros al estilo de Excel con listas de valores, celdas vacías y condiciones.

![Filtro de datos](docs/screenshots/es/data-filter.png)

### Scripts en el diagrama

Cada script vinculado a las tablas que usa, con su última ejecución.

![Scripts en el diagrama](docs/screenshots/es/scripts-in-diagram.png)

### Columnas de pgvector

Las dimensiones y un índice HNSW listo para copiar para la búsqueda por similitud.

![Columna de pgvector](docs/screenshots/es/pgvector-column.png)

### Consultas de pgvector

Las búsquedas de vecinos más cercanos que recorren todas las filas reciben una sugerencia de índice HNSW.

![Plan de consulta de pgvector](docs/screenshots/es/pgvector-query-plan.png)

### Relaciones de Apache AGE

Todas las aristas de un grafo, con filtro, búsqueda y edición en el lugar.

![Relaciones de AGE](docs/screenshots/es/age-relationships.png)

### Explorador de grafos

Una vista dirigida por fuerzas; haz doble clic en un vértice para expandir sus vecinos.

![Explorador de grafos de AGE](docs/screenshots/es/age-explorer.png)

## Funciones

- Abre archivos `.pgerd` desde **Archivo → Abrir**, arrastrándolos a la ventana, desde la línea de comandos
  (`npm start -- ruta/al/archivo.pgerd`) o con doble clic una vez instalada la aplicación (la aplicación
  empaquetada registra el tipo de archivo `.pgerd`). Los últimos 10 diagramas abiertos o guardados están en
  **Archivo → Abrir reciente** y en la pantalla de inicio de un diagrama vacío.
- Dibuja tablas con columnas, tipos, claves primarias (icono de llave) y claves foráneas (icono de enlace). Las
  relaciones usan la notación pata de gallo.
- Al seleccionar una tabla se abre una barra lateral. Muestra:
  - el nombre, el esquema y el número de columnas de la tabla
  - sus propiedades (nombre, esquema, comentario, nota, color del encabezado, clave primaria)
  - sus columnas, con iconos de PK/FK e indicadores de NOT NULL y valor predeterminado; haz clic en una para
    editarla
  - sus relaciones, en ambos sentidos

  Haz clic en una columna del diagrama para ir a ella. Arrastra el borde de la barra lateral para cambiar su
  tamaño y pulsa <kbd>Esc</kbd> o × para cerrarla. **Tablas**, en la cinta, muestra una lista filtrable de todas
  las tablas.
- Edición:
  - agregar, renombrar y eliminar tablas
  - editar columnas: nombre, tipo, longitud/escala, NOT NULL, PK, valor predeterminado, orden
  - establecer esquema, comentario, nota y color del encabezado
  - agregar y quitar relaciones, creando opcionalmente la columna FK
- Arrastra una tabla por su barra de título para moverla, y por su esquina inferior derecha para
  cambiar su tamaño (doble clic en la esquina la ajusta de nuevo a su contenido). <kbd>Ctrl</kbd>+clic selecciona varias tablas, y con <kbd>Shift</kbd>
  pulsado puedes arrastrar un rectángulo para seleccionar las tablas que toque
  (<kbd>Ctrl</kbd>+<kbd>Shift</kbd> las agrega a la selección); las tablas seleccionadas se arrastran, se
  mueven con las flechas y se eliminan juntas, y el panel lateral les asigna esquema y color de
  encabezado a la vez con **Aplicar**. Arrastra el fondo para desplazarte y usa la rueda para acercar o alejar.
  La barra de estado reúne los controles de vista, como en Word: un control deslizante de zoom (100% en el
  centro) con botones para alejar y acercar y el nivel de zoom, además de **Ajustar** y **Organizar** para
  ordenarlo todo, y los controles de la cuadrícula.
- Copia tablas con <kbd>Ctrl</kbd>+<kbd>C</kbd> o **Copiar tabla** en su menú contextual, y pégalas con
  <kbd>Ctrl</kbd>+<kbd>V</kbd> o **Pegar tabla aquí** sobre el fondo, también en otro diagrama. Al pegar una
  tabla se piden su nombre y su esquema (vacío equivale a `public` y se sugieren los esquemas
  existentes) y no se permite repetir un nombre; al pegar varias se pide el esquema y los nombres
  que ya existen en él reciben el sufijo `_copy`. Las claves foráneas entre las tablas copiadas apuntan
  a las copias nuevas; las que apuntan a tablas que no se copiaron se omiten.
- Detrás del diagrama se dibuja una cuadrícula (botón de cuadrícula en la barra de estado, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>G</kbd>), con
  una línea más marcada cada cinco celdas. Con **Imán** activado (<kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+<kbd>G</kbd>),
  las tablas arrastradas, los desplazamientos con las flechas, las tablas nuevas y la organización automática
  se ajustan a las líneas de la cuadrícula; mantén <kbd>Alt</kbd> al arrastrar para invertir el ajuste en ese
  movimiento, y <kbd>Mayús</kbd>+flecha mueve de 1 en 1 px. El tamaño de la cuadrícula se elige en la
  lista junto al botón Imán, y se guarda en el `gridSize` del archivo.
- Deshacer/rehacer, y un aviso de cambios sin guardar al cerrar la ventana.
- Guarda de nuevo en `.pgerd`. Las propiedades que esta aplicación no edita (tablespace, restricciones check,
  etc.) se conservan tal como estaban.
- Importa tablas desde **Excel (`.xlsx`/`.xlsm`) o CSV** con **Archivo → Importar desde Excel / CSV**
  (<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>), **Importar Excel** en el grupo Base de datos de la cinta o soltando el archivo en la
  ventana. Cada hoja se lee en uno de dos formatos:
  - **Definiciones de columnas:** una fila de encabezado con *Column* y *Type* (y cualquiera de *Table, Schema,
    Length, Scale, Nullable / Not null, PK, Unique, Default, References, Comment*), una fila por columna. Una
    columna *Table* divide la hoja en varias tablas (una celda vacía continúa la tabla de arriba); *References*
    acepta `tabla.columna`, `esquema.tabla.columna` o `tabla(columna)` y se convierte en una clave foránea. Las
    formas habituales de escribir los tipos (`varchar(50)`, `int`, `decimal(10,2)`, `datetime`, …) se
    convierten a tipos de PostgreSQL. Se reconocen encabezados en inglés y en español.
  - **Datos:** la primera fila da nombre a las columnas y las filas de abajo son datos. Los tipos (integer,
    bigint, numeric, boolean, date, timestamp, time, uuid, jsonb, text) se deducen de los valores, y una
    columna `id` con valores únicos se convierte en la clave primaria.

  El diálogo permite elegir y renombrar las tablas, establecer el esquema y ver el SQL. Los nombres se
  convierten a snake_case salvo que lo desactives. Las tablas que ya están en el diagrama se actualizan y
  conservan su posición. Los archivos `.xls` antiguos no se admiten; guárdalos antes como `.xlsx`.
- Importa tablas desde una **base de datos SQLite** con **Archivo → Importar desde base de datos SQLite…** o soltando en la
  ventana un archivo `.db`, `.sqlite`, `.sqlite3`, `.db3`, `.s3db` o `.sl3`. El archivo se abre en solo lectura y solo se lee
  su esquema; no se copian filas:
  - Los tipos declarados pasan a tipos de PostgreSQL (`DATETIME` → `timestamp`, `BLOB` → `bytea`, `REAL` → `double precision`,
    `VARCHAR(100)`, `DECIMAL(10,2)`, etc.). Un tipo que PostgreSQL no tiene se sustituye por el de su afinidad en SQLite, y
    una columna sin tipo pasa a `text`. Un `INTEGER PRIMARY KEY` pasa a `serial`.
  - Se conservan las claves primarias, `NOT NULL`, las restricciones `UNIQUE` e índices únicos de una sola columna y las
    claves foráneas.
  - Los valores por defecto se traducen (`datetime('now')` → `CURRENT_TIMESTAMP`, `1` → `true` en una columna booleana); un
    valor por defecto que llama a una función exclusiva de SQLite se descarta.
  - No se importan las vistas, las tablas virtuales, las restricciones `CHECK`, las restricciones únicas de varias columnas
    ni los índices no únicos.
  - El mismo diálogo de la importación de Excel permite elegir y renombrar las tablas, establecer el esquema y ver el SQL.
- Importa tablas desde **Microsoft SQL Server** (2008 o posterior, incluida Azure SQL Database):
  - **Archivo → Importar desde base de datos SQL Server…** pide el servidor (`host`, `host\instancia` o `host` y un puerto),
    la base de datos y un inicio de sesión de SQL Server o una cuenta de Windows (NTLM: usuario, contraseña y dominio), con
    el cifrado activado por defecto y una opción para confiar en un certificado autofirmado. Solo se leen las vistas del
    catálogo; no se escribe nada ni se copian filas. La configuración, salvo la contraseña, se recuerda para la próxima vez.
  - **Archivo → Importar desde script de SQL Server…** lee en su lugar un archivo `.sql`, como el que escribe SQL Server
    Management Studio con *Incluir tabla como → CREATE en* o *Generar scripts* (UTF-8 o UTF-16). Se entienden `CREATE TABLE`
    con restricciones de columna y de tabla, `ALTER TABLE … ADD` (restricciones, `DEFAULT … FOR`, columnas),
    `ALTER TABLE … DROP COLUMN`, `CREATE UNIQUE INDEX`, tipos alias (`CREATE TYPE … FROM`) y las descripciones de
    `sp_addextendedproperty`; las demás instrucciones se omiten. El script no se ejecuta.
  - Los tipos pasan a sus equivalentes de PostgreSQL: `nvarchar(50)` → `character varying(50)`, `nvarchar(max)` → `text`,
    `datetime` / `datetime2` → `timestamp`, `datetimeoffset` → `timestamp with time zone`, `bit` → `boolean`,
    `uniqueidentifier` → `uuid`, `money` → `numeric(19,4)`, `varbinary` / `image` / `rowversion` → `bytea`,
    `tinyint` → `smallint`; `sql_variant` y `hierarchyid` pasan a `text`. Una columna `IDENTITY` de tipo entero pasa a
    `serial`, `bigserial` o `smallserial`.
  - Se conservan las claves primarias, `NOT NULL`, las restricciones únicas e índices únicos de una sola columna (no los
    filtrados), las claves foráneas y los comentarios `MS_Description`. Los valores por defecto se traducen
    (`getdate()` / `sysdatetime()` → `CURRENT_TIMESTAMP`, `newid()` → `gen_random_uuid()`, `N'…'` → `'…'`, `((1))` → `true`
    en una columna `bit`); uno que llama a otra función se descarta.
  - Las tablas del esquema `dbo` van al esquema indicado en el diálogo; los demás esquemas conservan su nombre (en
    snake_case cuando se convierten los nombres).
  - No se importan las vistas, las expresiones de columnas calculadas (la columna se conserva), las restricciones `CHECK`,
    las acciones de las claves foráneas, las restricciones únicas de varias columnas ni los índices no únicos.
- Importa tablas desde **clases de Entity Framework Core o JSON** con **Archivo → Importar desde Entity Framework / JSON…** o
  soltando archivos `.cs` en la ventana. Elige juntas las clases de entidad y el `DbContext`; se leen como texto, no se compila nada:
  - **Entidades:** las propiedades públicas (también las heredadas) se convierten en columnas. Se respetan los nombres de los
    `DbSet`, `[Table]`, `[Column]`, `[Key]`, `[PrimaryKey]`, `[Required]`, `[MaxLength]`, `[StringLength]`, `[Precision]`, `[Index]`,
    `[Comment]`, `[DatabaseGenerated]` y `[NotMapped]`, y las claves `int`/`long` pasan a `serial`/`bigserial`.
  - **API fluida:** se leen `OnModelCreating` e `IEntityTypeConfiguration<T>`: `HasDefaultSchema`, `ToTable`, `HasKey`,
    `Property(...)` (`HasColumnName`, `HasMaxLength`, `IsRequired`, `HasColumnType`, `HasPrecision`, `HasDefaultValue`, `HasDefaultValueSql`),
    `HasIndex().IsUnique()`, `Ignore` y `HasOne`/`HasMany`/`WithOne`/`WithMany`/`HasForeignKey`/`HasPrincipalKey`.
  - **Relaciones:** las claves foráneas salen de la API fluida, de `[ForeignKey]` o de las convenciones de nombres de EF (una
    columna sombra si no hay propiedad de clave); dos colecciones que se apuntan entre sí generan una tabla de unión. Las clases
    derivadas de otra entidad comparten su tabla con una columna `discriminator`. No se siguen los tipos propios (owned) ni las conversiones de valores.
  - **JSON:** `{ "schema": "app", "tables": [{ "name": "person", "columns": [{ "name": "id", "type": "serial", "pk": true }, { "name": "boss_id", "type": "int", "references": "person.id" }] }] }`.
    Las columnas aceptan `type`, `length`, `precision`/`scale`, `nullable` o `notNull`, `pk`, `unique`, `default`, `description` y
    `references` (`tabla.columna` o `esquema.tabla.columna`); una tabla también puede listar `primaryKey` y `foreignKeys`.
  - El mismo diálogo de la importación de Excel permite elegir y renombrar las tablas y ver el SQL. Hay un ejemplo en
    [docs/examples/ShopContext.cs](docs/examples/ShopContext.cs).
- Importa tablas desde **MySQL** (5.7 o posterior) y **MariaDB** (10.2 o posterior):
  - **Archivo → Importar desde base de datos MySQL / MariaDB…** pide el host, el puerto, la base de datos, el usuario, la
    contraseña y el modo SSL (desactivado, obligatorio sin comprobar el certificado, o verificado). Solo se lee
    `information_schema`.
  - **Archivo → Importar desde volcado de MySQL / MariaDB…** lee un archivo `.sql` escrito por `mysqldump`, `mariadb-dump` o
    `SHOW CREATE TABLE`: sus `CREATE TABLE` dan las tablas y sus `INSERT` son las filas que copia **Copiar filas** (abajo).
    Un volcado de varias bases de datos (`USE` antes de cada una) conserva cada una como esquema. El volcado no se ejecuta.
  - Tipos: `tinyint(1)` → `boolean`, `int unsigned` → `bigint`, `bigint unsigned` → `numeric(20,0)`, `datetime` →
    `timestamp`, `timestamp` → `timestamp with time zone` (MySQL lo guarda en UTC), `enum` / `set` → `text`, `blob` →
    `bytea`, `json` → `jsonb` (también el JSON de MariaDB, un `LONGTEXT` con una comprobación `json_valid`), `year` →
    `smallint`, `bit(1)` → `boolean`, tipos espaciales → `geometry` (requiere PostGIS). Un entero `AUTO_INCREMENT` pasa a
    un tipo serial.
  - Se conservan las claves primarias, `NOT NULL`, las claves únicas de una sola columna (no las de prefijo ni las
    funcionales), las claves foráneas y los comentarios. Los valores por defecto se traducen (`CURRENT_TIMESTAMP(3)`,
    `now()` → `CURRENT_TIMESTAMP`, `uuid()` → `gen_random_uuid()`, `'1'` → `true` en un booleano, `b'0'` → `false`).
- Importa tablas desde **Oracle Database** (12.1 o posterior) con **Archivo → Importar desde Oracle Database…**: host,
  puerto, nombre del servicio, usuario, contraseña y, opcionalmente, el esquema a leer (por defecto el del usuario).
  node-oracledb funciona en modo Thin, así que no se instala Oracle Client. Solo se leen las vistas `ALL_*` del diccionario.
  - Tipos: `NUMBER(p)` → `smallint` / `integer` / `bigint` / `numeric(p,0)` según el tamaño, `NUMBER(p,s)` →
    `numeric(p,s)`, `NUMBER` → `numeric`, `VARCHAR2` / `NVARCHAR2` → `character varying` (en caracteres), `CLOB` → `text`,
    `BLOB` → `bytea`, `RAW(16)` → `uuid`, `DATE` → `timestamp(0)` (un `DATE` de Oracle tiene hora),
    `TIMESTAMP WITH [LOCAL] TIME ZONE` → `timestamp with time zone`, `INTERVAL` → `interval`, `XMLTYPE` → `xml`, `JSON` →
    `jsonb`. Una columna de identidad pasa a un tipo serial. Los nombres en mayúsculas pasan a snake_case
    (`CUSTOMER_ID` → `customer_id`).
  - Se conservan las claves primarias, `NOT NULL`, las restricciones únicas e índices únicos de una sola columna, las
    claves foráneas (una clave a otro esquema apunta a un esquema con ese nombre) y los comentarios; `SYSDATE` /
    `SYSTIMESTAMP` → `CURRENT_TIMESTAMP`, `SYS_GUID()` → `gen_random_uuid()`.
- En todas las importaciones una columna de clave foránea toma el tipo de la columna a la que apunta, para que la clave
  se pueda crear.
- **Copiar filas**: después de agregar al diagrama tablas de MySQL / MariaDB, SQL Server, Oracle, SQLite o de un volcado de
  MySQL, **Copiar las filas a la base de datos conectada** crea las tablas que faltan en la base de datos PostgreSQL
  conectada y copia todas las filas, vaciando antes las tablas si se pide. Todo ocurre en **una sola transacción**: las
  tablas se crean sin claves foráneas, las filas entran por lotes con cada valor enviado como parámetro, luego se agregan
  las claves foráneas y la secuencia de cada columna serial se mueve después de las claves copiadas. Si algo falla, o
  pulsas **Detener**, no se cambia nada. Requiere una conexión cuya política permita escrituras y cambios de esquema, y
  queda en el registro de auditoría. Los valores llegan sin cambios: números y decimales como texto (sin redondeo), fechas
  y horas por su valor de reloj, las fechas cero de MySQL como `NULL`, los datos binarios como `bytea` y el JSON como
  `jsonb`. La copia es una instantánea, no una replicación continua.
- Vista previa SQL en vivo con resaltado de sintaxis, y exportación a DDL de PostgreSQL (`CREATE TABLE`, claves
  primarias, restricciones únicas, claves foráneas, comentarios), SVG o PNG. **Guardar como…**
  (<kbd>Ctrl</kbd>+<kbd>Mayús</kbd>+<kbd>S</kbd>) escribe cualquiera de ellos: el tipo de archivo elegido en el
  diálogo (`.pgerd`, `.sql`, `.svg` o `.png`) decide el formato.
- Una cinta de opciones al estilo de Office con grupos de comandos con nombre e iconos a dos colores, que
  comparten los menús nativos y los diálogos.
- Temas en **Ver → Tema**: Blanco, Oscuro, Visual Studio (Azul clásico) y Windows ME, o el tema claro u oscuro del
  sistema (predeterminado).
- Disponible en inglés y en español (consulta [Idiomas](#idiomas)).

## Sincronización con la base de datos

El menú **Base de datos** (el botón *Conectar* de la cinta, e **Importar desde la base de datos…** y **Comparar** en la pestaña Diagrama) trabaja con un servidor
PostgreSQL 10+ en vivo:

- **Conectar:** servidor, puerto, base de datos, usuario, contraseña y modo SSL. Las conexiones se pueden
  guardar como instancias con nombre (con su entorno y su política) y elegir de una lista; doble clic en una
  para conectar. Marca **Recordar la contraseña** para guardarla cifrada con el almacén de credenciales del
  sistema operativo (DPAPI, Llavero, libsecret/kwallet); sin almacén de credenciales se conserva en memoria
  hasta que se cierra la aplicación. Una contraseña guardada solo se envía al servidor, puerto y usuario para
  los que se guardó. **Reconectar a la última instancia** reabre la última sesión al abrir una ventana.
  Conectarse a otra base de datos pide confirmación primero: cierra el diagrama (descartando los cambios sin
  guardar), las pestañas de datos y el generador de consultas, y borra los resultados de la consulta.
- **Importar tablas:** lista todas las tablas de la base de datos por esquema, con su número de columnas e
  indicando si ya están en el diagrama. Las tablas seleccionadas que son nuevas se agregan al diagrama con sus
  columnas, claves primarias, restricciones únicas y claves foráneas. Las que ya están en el diagrama se
  actualizan desde la base de datos; se conservan su posición, color y nota. Las columnas serial vuelven como
  `serial`/`bigserial`.
- **Explorador:** un panel a la izquierda del diagrama con un árbol de los esquemas, tablas y columnas de la
  base de datos conectada. Arrastra una tabla al diagrama (o haz doble clic) para agregarla donde la sueltes;
  sus claves foráneas hacia y desde tablas que ya están en el diagrama se dibujan como relaciones. Las tablas
  que ya están en el diagrama aparecen marcadas. Muestra u oculta el panel con **Explorador** en el grupo
  Base de datos. El mismo panel acompaña al generador de consultas en la pestaña **Generador**.
- **Comparar / sincronizar:** compara el diagrama con la base de datos (por esquema) y lista todas las
  diferencias:
  - tablas y columnas nuevas y eliminadas
  - cambios de tipo, `NOT NULL`, valor predeterminado e identidad
  - claves primarias, restricciones únicas y claves foráneas (incluidos los cambios de `ON DELETE`/`ON UPDATE`)
  - comentarios de las tablas

  Cada cambio tiene una casilla, así que puedes dejar algunos fuera. Después genera el SQL de migración que hace que la base de datos coincida con el diagrama. Puedes copiarlo o
  guardarlo, o ejecutarlo en la base de datos en una sola transacción; si alguna sentencia falla, no se aplica
  nada.
  - Las sentencias se ordenan para que funcionen: las claves foráneas dependientes se eliminan antes que la
    clave a la que hacen referencia y se vuelven a crear después.
  - Las sentencias destructivas (`DROP COLUMN`, `DROP TABLE`) solo se incluyen si marcas la opción
    correspondiente. Si no, aparecen como comentarios al final del script.
  - Un cambio de tipo convierte los valores con una conversión (cast); **Eliminar y volver a crear las columnas
    cuyo tipo cambió** elimina la columna y la vuelve a agregar, para tipos que una conversión no puede cambiar
    (sus datos se pierden y pasa al final de la tabla).
  - No se pueden detectar tablas o columnas renombradas: aparecen como una eliminación más una adición.

## pgvector

Las columnas de [pgvector](https://github.com/pgvector/pgvector) (`vector`, `halfvec`, `sparsevec`) se
admiten en toda la aplicación:

- **Diagrama:** los tipos están en la lista de tipos de columna, y su longitud es el número de dimensiones
  (`vector(1536)`). El editor de columnas muestra el índice HNSW para la búsqueda por coseno, listo para
  copiar. Los vectores de más de 2000 dimensiones reciben un índice de expresión `halfvec`, que funciona hasta
  4000.
- **Exportación SQL y migraciones** agregan `CREATE EXTENSION IF NOT EXISTS vector;` cuando el diagrama usa
  tipos vector. Comparar / sincronizar solo lo agrega si la base de datos todavía no tiene la extensión.
- **Scripts:** los valores `vector` y `halfvec` se leen como `number[]` y se pueden escribir como `number[]`,
  `Float32Array` o texto de pgvector (`'[1,2,3]'`). Los valores `sparsevec` son cadenas (`'{1:0.5,3:1}/5'`) y
  se pueden escribir como arreglos densos. `where({ embedding: [1, 2, 3] })` compara con un vector.
  `seed.row()` / `seed.fill()` generan vectores unitarios aleatorios, y `seed.check()` comprueba las
  dimensiones.
- **Analizador de consultas:** una búsqueda de vecinos más cercanos (`ORDER BY embedding <=> $1 LIMIT n`) que
  ordena todas las filas recibe una sugerencia de índice HNSW con la clase de operador de su operador (`<->`,
  `<=>`, `<#>`, `<+>`). También señala un índice vectorial existente creado para otro operador.
- **Pestañas de datos:** muestran los vectores largos abreviados como `[0.1,0.2,…] (1536 dim.)`; pasa el
  puntero sobre una celda para ver el valor completo.

## Grafos de Apache AGE

La pestaña **Grafo** (Base de datos → Grafos, <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>) gestiona los grafos
de propiedades de [Apache AGE](https://age.apache.org) de la base de datos conectada:

- **Barra lateral:** los grafos de la base de datos con sus etiquetas de vértice y tipos de relación, y cuántos
  vértices o relaciones tiene cada uno. Aquí puedes crear y eliminar grafos y etiquetas. Si el servidor tiene
  AGE disponible pero la base de datos todavía no lo usa, **Instalar AGE** ejecuta `CREATE EXTENSION age`.
- **Relaciones:** todas las relaciones, mostradas como *origen — TIPO → destino*. Puedes filtrar por tipo,
  buscar en las propiedades y etiquetas de la relación y de ambos vértices, y recorrer la lista por páginas.
  **Nueva relación** elige los dos vértices buscándolos mientras escribes y establece el tipo (un tipo nuevo se
  crea automáticamente) y las propiedades en JSON. Cada fila se puede editar en el lugar o eliminar.
- **Vértices:** los vértices con su número de relaciones. Puedes crearlos, editarlos y eliminarlos (al
  eliminar uno también se eliminan sus relaciones). **Conectar** inicia una relación desde ese vértice, y al
  hacer clic en el número se listan las relaciones de ese vértice.
- **Explorador:** una vista dirigida por fuerzas. Carga una muestra del grafo o busca un vértice; después haz
  doble clic en un vértice para expandir sus vecinos y arrastra, desplaza y acerca según necesites. Selecciona
  un vértice o una relación para editar sus propiedades. Para conectar dos vértices, usa **Conectar…** y haz
  clic en el destino, o haz Mayús+clic en él.
- **Cypher:** ejecuta consultas Cypher en el grafo seleccionado. Las columnas del resultado salen de la
  cláusula `RETURN`, o puedes indicarlas para `RETURN *`. Los vértices, aristas y caminos se muestran de forma
  legible y se pueden abrir en el explorador.

Los cambios se confirman de inmediato, necesitan una conexión cuya política permita escrituras (los grafos y
las etiquetas también necesitan cambios de esquema) y quedan registrados en el registro de auditoría. Las
eliminaciones piden confirmación. Las consultas Cypher que modifican el grafo (`CREATE`, `MERGE`, `SET`,
`DELETE`, `REMOVE`) solo se ejecutan si marcas **Permitir cambios**; las demás se ejecutan en una transacción
de solo lectura. Los ids de los elementos del grafo son de 64 bits, así que se guardan como cadenas y nunca se
redondean. Los esquemas propios de AGE (`ag_catalog` y uno por grafo) se dejan fuera de **Importar desde la base de datos…** y
**Comparar**.

La sesión ejecuta `LOAD 'age'`, o `$libdir/plugins/age` para usuarios que no son superusuarios, salvo que AGE
ya esté en `shared_preload_libraries`.

## Pestañas del banco de trabajo

### Scripts

Los scripts son archivos de TypeScript que se guardan junto al diagrama, en `scripts/<tipo>/` (validadores,
generadores, cargas de datos, migraciones, consultas, mantenimiento, importaciones, exportaciones), para que
puedan estar en el control de versiones. La primera línea guarda sus metadatos
(`// @pgsql-erd {"type":"validator"}`).

- **Editor Monaco con IntelliSense para tu base de datos.** Los tipos se generan a partir de la base de datos
  conectada (o del diagrama sin conexión): cada tabla recibe una interfaz de fila y otra de inserción, y
  `db.public.tbUsuarios.insert({ nombre: 123 })` se marca con *Type 'number' is not assignable to type
  'string'*. También se señalan los nombres de tabla desconocidos en `db.table("…")`. Los tipos también se
  escriben en `generated/database.d.ts` para otros editores y se actualizan con **Base de datos → Actualizar
  esquema**.
- **API de scripts** (globales, sin imports):
  - `db.public.orders.where({ status: ["new", "paid"], total: { gt: 10 } }).orderBy("id").limit(50).select()`,
    `.first()`, `.count()`, `.insert(row)`, `.insertMany(rows)`, `.update(values)`, `.delete()`
  - `db.query(sql, params)`, `db.transaction(async (tx) => …)` (un savepoint),
    `db.describe.table() / relationships() / insertOrder()`, `db.preview()`
  - `validate(nombre, async () => { report.error({ table, row, column, message }) })`, `report.warning/info`,
    `log()`
  - `faker` (datos ficticios con semilla), `seed.row(tabla)`, `seed.fill(tabla, n)` (valores verosímiles,
    claves foráneas válidas, valores únicos que no chocan con las filas existentes), `seed.check(tabla, fila)`
- **Simular** (F6) ejecuta el script en una transacción que siempre se revierte e informa de las inserciones,
  actualizaciones, eliminaciones y filas leídas por tabla. **Ejecutar** (F5) mantiene la transacción abierta si
  el script modificó datos y te pide confirmar o descartar (se revierte automáticamente a los 10 minutos).
- **Permisos** por script, a partir de perfiles (Solo lectura, Validador, Generador de datos, Carga de datos,
  Migración, Acceso completo) más ajustes individuales: leer filas, SELECT directo, INSERT, UPDATE, DELETE, DDL,
  escrituras con SQL directo. Los scripts sin permisos de escritura se ejecutan en una transacción
  `READ ONLY`, así que PostgreSQL también lo impone.
- **Validadores:** listan cada `validate()` como correcto o fallido; al hacer clic en un error se muestra la
  fila afectada, la validación en el editor y enlaces a la tabla en el diagrama y en una pestaña de datos.

### Scripts en el diagrama

**Mostrar scripts** (abajo a la izquierda del diagrama, o **Ver → Mostrar scripts en el diagrama**) dibuja los
scripts guardados del proyecto como entidades junto a las tablas que usan. Un script se vincula a las tablas que
nombra en su código o que aparecen en sus metadatos, con una línea discontinua etiquetada según lo que hace:
*valida*, *genera*, *carga*, *migra*, *importa a*, *exporta de*, *consulta*. Cada recuadro muestra el tipo del
script y su última ejecución en esta máquina: OK o FALLA con el número de validaciones, filas modificadas y
filas revisadas.

- Arrastra los recuadros para colocarlos; sus posiciones se guardan en `pgsql-erd.json`, no en el archivo
  `.pgerd`, así que el diagrama sigue siendo compatible con pgAdmin. Las imágenes SVG y PNG exportadas incluyen
  los scripts mientras se muestran.
- Haz clic en un recuadro para ver sus detalles y las tablas vinculadas, con **Abrir script** y
  **Ejecutar validador** / **Simular**; con doble clic se abre en la pestaña Scripts.
- La barra lateral de una tabla lista los scripts que la usan, con su último resultado.
- Los scripts están ocultos de forma predeterminada, para que los diagramas grandes sigan siendo legibles.

### Consulta

Un editor SQL con autocompletado de tablas y columnas. **Ejecutar** (Ctrl+Intro) ejecuta la selección o todo
en una transacción de solo lectura; las sentencias que modifican datos o el esquema necesitan **Permitir
cambios**, una confirmación y una conexión que permita escrituras, y se confirman juntas. **Explicar** muestra
el plan estimado y **Explicar y analizar** (Ctrl+Mayús+Intro) el real (siempre se revierte), como un árbol con
filas, tiempo propio y una barra por nodo. Las sugerencias señalan recorridos secuenciales que descartan la
mayoría de las filas, estimaciones de filas erróneas, ordenaciones y hashes que se vuelcan a disco y claves
foráneas sin índice, con la sentencia `CREATE INDEX` / `ANALYZE` lista para insertar.

El explorador de la base de datos está junto al editor (**Explorador**): arrastra una tabla al SQL, o haz doble
clic, para insertar su nombre. **+ Consulta** junto a **+ Datos** abre más pestañas de consulta, cada una con su
SQL, resultados y plan; los archivos `.sql` abiertos o soltados tienen su propia pestaña. Las pestañas de consulta
y su SQL se recuerdan entre sesiones, y cerrar una con SQL sin guardar pide confirmación.

### Generador

Un generador visual de consultas (Base de datos → Generador de consultas, Ctrl+Alt+U). Arrastra tablas desde el
explorador de la base de datos al lienzo (o haz doble clic) y marca las columnas que quieres obtener; la casilla
del encabezado marca todas. Las tablas con una clave foránea entre ellas se unen automáticamente por sus columnas:

- una tabla agregada dos veces recibe su propio alias y la siguiente clave foránea: una segunda tabla
  `addresses` junto a `orders` se une por la dirección de envío cuando la primera tomó la de facturación
- una tabla que se referencia a sí misma (`employees.manager_id`) se puede agregar dos veces para unirla
  consigo misma
- arrastra una columna sobre la columna de otra tabla para unirlas a mano

Cada unión tiene un pequeño menú sobre su línea, con su nombre SQL: solo las filas que coinciden (`INNER JOIN`),
todas las filas de una tabla (`LEFT` / `RIGHT JOIN`) o de ambas (`FULL JOIN`). Los alias se pueden cambiar en los encabezados de las
tablas; **Sin duplicados** y **Límite** completan la sentencia. El SQL aparece debajo del lienzo mientras
trabajas: **Abrir en Consulta** lo pone en la pestaña Consulta y **Ejecutar** además lo ejecuta ahí;
**Guardar…** escribe el SQL en un archivo. Cada pestaña Generador tiene su propia consulta, y se recuerdan
entre sesiones.

### Diseñador de importación

Asigna las hojas de un libro de Excel a tablas de PostgreSQL y exporta una **plantilla de importación**
reutilizable y portátil (Base de datos → Diseñador de importación desde Excel, Ctrl+Alt+M, o **Importación** en la
barra de pestañas). Tres paneles: el explorador de la base de datos, un lienzo de mapeo y una vista de solo
lectura de un libro de ejemplo.

- Abre un `.xlsx` de ejemplo a la derecha (o una carpeta de archivos JSON, o **Abrir base de datos…**: las tablas de una
  base de datos MySQL / MariaDB, SQL Server, Oracle o SQLite o de un volcado de MySQL, una hoja por tabla con los nombres de
  las columnas en su primera fila) y usa **Agregar como origen**: un bloque de origen por hoja. Las filas de una base de
  datos se leen al abrirla, hasta 100 000 por tabla, y **Ejecutar** las importa a través de los bloques como las filas de
  un libro; la plantilla no guarda ninguna conexión. Elige cómo
  se encuentra: por nombre, posición o sus encabezados; en una **posición fija** (p. ej. encabezados en `C4`,
  datos desde `C5`, con filas de título arriba) o **buscando los nombres de encabezado** en un rango de filas,
  de modo que columnas reordenadas y encabezados desplazados sigan funcionando. Haz clic en una celda de la
  vista previa para mover el encabezado o la primera fila de datos.
- Arrastra tablas desde el explorador: cada una es una tarea INSERT (la misma tabla se puede agregar más de una
  vez). Arrastra del punto de una columna de Excel a una columna de la tabla para mapearla; **Mapear por nombre**
  conecta los nombres que coinciden.
- **Orden de inserción** lista las tareas: reordénalas arrastrando o con las flechas, o usa **Sugerir orden**
  para poner primero las tablas referenciadas (los ciclos se informan, nunca se rompen en silencio). La tarea 1
  inserta todas sus filas, luego la tarea 2.
- Los **bloques de procesamiento** (barra de herramientas) van entre la hoja y una columna de tabla. El **Bloque
  de división** corta una celda en un separador (una coma por omisión) para una columna tipo `text[]`. La **Lista
  desplegable de tabla** da a una columna un valor elegido entre las filas de una tabla, con cuadro de búsqueda,
  cuando se ejecuta la importación; el valor predeterminado elegido en el diseñador se guarda en la plantilla.
  El **Bloque de búsqueda** encuentra una clave foránea a partir de un valor de la hoja: busca el texto en una
  tabla (columna de comparación y columna a devolver) al ejecutar la importación, después de las tareas
  anteriores, así que encuentra los ids recién generados. En los nodos de tabla, **las columnas de clave primaria tienen un punto a la derecha**: arrástralo a una
  columna de una tarea posterior que lea la misma hoja para usar la clave que devuelve el INSERT
  (`inserted.<clave primaria>`, `RETURNING` en PostgreSQL), de modo que las filas hijas reciban el id generado
  para su fila padre. La tarea padre se mueve antes de la hija si hace falta. Las flechas de las conexiones
  muestran la dirección de los datos.
- **Problemas** revisa el diseño contra el libro de ejemplo y la base de datos; **Vista previa** muestra las filas
  que insertaría cada tarea; ninguna de las dos escribe en la base de datos.
- **Ejecutar** (barra de herramientas) aplica el diseño a la base de datos conectada con las filas del libro
  abierto, tarea por tarea en el orden de inserción. Necesita una conexión cuya política permita escribir, muestra
  cuántas filas insertará cada tarea y pregunta antes; la pestaña de resultado muestra las filas insertadas por
  tarea o la tarea y la fila de la hoja que fallaron. Con "todas las tareas juntas" un fallo deshace todo, y con
  "una por tarea" las tareas anteriores quedan confirmadas. Cada ejecución queda en el registro de auditoría.
- **Guardar** / **Guardar como…** de la cinta escriben un `.import.json` versionado, sin datos de ejemplo,
  credenciales ni rutas (tras revisar el diseño). **Abrir** la recupera con sus mapeos, orden y disposición. Deshacer/rehacer (Ctrl+Z / Ctrl+Y), zoom
  (Ctrl + rueda) y Supr funcionan en el lienzo. Los nodos se comportan como las tablas del diagrama: se mueven por
  la barra de título y se redimensionan desde la esquina inferior derecha (doble clic para ajustar al contenido).
  Haz clic en una conexión para seleccionarla y pulsa Supr o su botón × para quitarla.

La plantilla es el producto: un servidor o una CLI puede ejecutarla contra cualquier libro estructuralmente
compatible con el mismo código (`src/shared/import-template.js`). Describe solo INSERT simples: los valores se
copian como texto, sin búsquedas, claves generadas ni transformaciones. Consulta
[docs/import-template-spec.md](docs/import-template-spec.md) y
[docs/import-template.schema.json](docs/import-template.schema.json).

### Pestañas de datos

**Datos**, en la barra de pestañas (o **Ver datos** en la barra lateral de una tabla, o **Base de datos →
Explorar datos de una tabla…**), abre una tabla en su propia pestaña: una cuadrícula con
paginación (100/500/1000 filas), encabezados fijos, **Copiar** (separado por tabulaciones, se pega en una hoja
de cálculo) y **Markdown** (la página como tabla de Markdown). Cada encabezado de columna tiene un menú de filtro al estilo de Excel:

- ordenar de forma ascendente / descendente (según el tipo de la columna: los números y las fechas se ordenan
  como tales)
- una lista de los valores distintos de la columna con su recuento, **(Vacías)**, **(Seleccionar todo)** y un
  cuadro de búsqueda; como en Excel, la lista tiene en cuenta los filtros de las demás columnas
- filtros de texto (contiene, comienza por, es igual a, está vacío, …) o de número / fecha (mayor que,
  entre, …)

Los filtros activos se muestran como etiquetas encima de la cuadrícula.

**Editar filas** hace editable la cuadrícula, como *Edit rows* en SQL Server Management Studio: haz clic en una
celda para cambiarla (Intro / Tab pasan a la siguiente, Mayús+Intro agrega una línea, Esc cancela, **Ctrl+0**
pone NULL), haz clic en la última fila (`*`) para agregar una fila (las columnas que quedan como
*(predeterminado)* reciben su DEFAULT) y en **×** para eliminar una. Las celdas cambiadas y las filas nuevas o
eliminadas se resaltan hasta **Guardar**, que las aplica todas en una transacción (o ninguna, si otra persona
cambió una fila mientras tanto) y las registra en el log de auditoría. Las filas se localizan por su clave
primaria, así que en las tablas sin ella solo se pueden agregar filas; las columnas identity (`GENERATED ALWAYS`)
y las generadas son de solo lectura. La edición solo se ofrece cuando la política de la conexión permite
escrituras, y fuera de desarrollo se pide confirmación antes de guardar.

## Modelo de seguridad

- La página (renderer) nunca ejecuta scripts ni ve credenciales: la contraseña de la base de datos se envía
  una vez al conectar y se queda en el proceso principal. Las contraseñas
  guardadas se cifran con el almacén de credenciales del sistema operativo y nunca se devuelven a la página.
- Los scripts se ejecutan en un proceso aparte (el Node de Electron) con un entorno vacío, un límite de
  memoria, un tiempo máximo y el modelo de permisos de Node: sin escritura de archivos, sin lecturas fuera de
  la aplicación y sin procesos hijos. El proceso no tiene conexión a la base de datos; cada llamada `db.*` va al
  proceso principal, que comprueba los permisos del script y la política de la conexión.
- Las conexiones tienen un entorno (desarrollo, pruebas, preproducción, producción) y una política: producción
  es de solo lectura de forma predeterminada, se muestra en rojo y bloquea el DDL, incluidas las migraciones
  del diálogo de comparación.
- Las escrituras se revisan antes de confirmarse; `BEGIN`/`COMMIT` dentro de los scripts se rechazan.
- Un registro de auditoría (**Base de datos → Abrir registro de auditoría**, y la pestaña Actividad) guarda las
  conexiones, las actualizaciones de esquema y las migraciones, las ejecuciones y confirmaciones de scripts, las
  escrituras de la pestaña Consulta y los cambios de configuración.

## Idiomas

La aplicación está disponible en **inglés** (English) y **español**. Sigue el idioma del sistema operativo y,
si no lo tiene, usa el inglés. Para elegir uno tú mismo, usa **Ver → Idioma**; los menús cambian de inmediato
y las ventanas abiertas cambian cuando se reinicia la aplicación (ofrece reiniciarla). La elección se guarda en
`settings.json`, en la carpeta de datos de usuario de la aplicación. Los números y las fechas siguen el idioma
elegido.

Las traducciones cubren toda la interfaz: menús, diálogos, la barra lateral del diagrama, todas las pestañas,
los resúmenes de comparación / migración y las sugerencias del plan de consulta. Los mensajes que vienen del
propio PostgreSQL y los nombres de los nodos del plan (`Seq Scan`, `Hash Join`) se quedan como los informa el
servidor.

## Primeros pasos

```bash
npm install
npm start                          # diagrama vacío
npm start -- samples/shop.pgerd    # abrir un archivo
```

## Desarrollo

Las notas técnicas para quien trabaja en el código están en [devlog/](devlog/): compilar y probar, convenciones
de código, la estructura del proyecto, el [formato de archivo .pgerd](devlog/pgerd-format.md), cómo se toman
las capturas y las notas de diseño de funciones como el asistente de IA desactivado. Empieza por
[devlog/DEVELOPMENT-es.md](devlog/DEVELOPMENT-es.md).

## Licencia

[MIT](LICENSE)
