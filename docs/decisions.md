# Registro de Decisiones de Arquitectura (ADR)

## ADR-001: Backend ligero con Node.js LTS y Fastify
- **Contexto**: Se necesita un servidor web rápido, seguro y con bajo consumo de memoria (<= 50 MB en reposo) para VPS modestos.
- **Decisión**: Fastify frente a Express o NestJS por su rendimiento superior, soporte nativo de esquemas de validación y soporte de WebSockets modular (`@fastify/websocket`).
- **Consecuencias**: Arranque casi instantáneo, mínimo overhead y alta capacidad para flujos concurrentes de terminales.

## ADR-002: Base de datos SQLite embebida con WAL
- **Contexto**: Citadel debe ser autónomo por servidor sin requerir un demonio de base de datos como PostgreSQL o MySQL.
- **Decisión**: SQLite utilizando `better-sqlite3` con modo WAL (`journal_mode = WAL`) y sincronización normal.
- **Consecuencias**: Cero mantenimiento de base de datos, archivo único en `data/citadel.db`, respaldos directos por copia de archivo y persistencia inmediata.

## ADR-003: Persistencia de terminales mediante desacoplamiento PTY + tmux
- **Contexto**: Un PTY puro muere si se interrumpe la conexión o se reinicia el proceso del panel. Los agentes de IA de larga ejecución (como Claude Code compilando o editando) perderían su estado de trabajo.
- **Decisión**: Utilizar `tmux` como backend de persistencia de sesiones. `node-pty` actúa como puente WebSocket entre el cliente xterm.js y `tmux attach/new-session`.
- **Consecuencias**: Desconectar el navegador no interrumpe el proceso; reconectarse restaura la pantalla completa. Si `tmux` no existe en el sistema, fallback a PTY directo.

## ADR-004: Autenticación por sesiones y cookies HttpOnly
- **Contexto**: La plataforma gestiona comandos y archivos en el servidor. El robo de tokens en localStorage vía XSS sería catastrófico.
- **Decisión**: Sesiones almacenadas en SQLite con identificador aleatorio de 256 bits, transmitido en cookie `HttpOnly`, `SameSite=Strict`, y `Secure` (cuando se usa HTTPS).
- **Consecuencias**: Protección contra robo de tokens desde JavaScript; expiración automática y capacidad de revocación inmediata.

## ADR-005: Control estricto de Path Traversal y enlaces simbólicos
- **Contexto**: La gestión de proyectos permite abrir y clonar repositorios en el disco del host. Rutas maliciosas (`../../etc/passwd` o symlinks) podrían comprometer el sistema.
- **Decisión**: Toda ruta de proyecto pasa por verificación de resolución canónica (`fs.realpathSync`) y validación de prefijo contra la lista de directorios permitidos (`PROJECTS_DIR` o rutas autorizadas explícitamente).
- **Consecuencias**: Se previenen fugas fuera del árbol de trabajo autorizado.

## ADR-006: Lanzamiento de agentes con procesos estructurados
- **Contexto**: Iniciar herramientas de IA con cadenas de shell arbitrarias expone al sistema a inyección de comandos.
- **Decisión**: El registro de agentes define binarios permitidos y argumentos estructurados (`string[]`). Se ejecuta directamente el binario validado en el directorio de trabajo del proyecto.
- **Consecuencias**: Cero inyecciones de comandos en la capa de agentes.

## ADR-007: Integraciones opcionales como proveedores desacoplados
- **Contexto**: No todos los servidores tienen Docker o Caddy instalados.
- **Decisión**: Caddy y Docker se implementan con detección previa de disponibilidad. Si la API o el socket no responden, la interfaz muestra el estado "No disponible / Opcional" sin degradar la funcionalidad principal de proyectos y terminales.
- **Consecuencias**: El núcleo funciona al 100% en un VPS limpio sin Docker ni Caddy.
