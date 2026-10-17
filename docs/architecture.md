# Citadel — Arquitectura del Sistema

## 1. Visión General y Principios de Diseño

Citadel es una plataforma web autohospedada, ultraligera, modular y segura diseñada para desarrolladores y agentes de IA que trabajan en VPS. Proporciona:

- Gestión unificada de proyectos y repositorios Git.
- Terminales web interactivas y persistentes (`xterm.js` + `node-pty` + `tmux`).
- Lanzador de herramientas y agentes CLI de Inteligencia Artificial (Claude Code, Codex, OpenCode, y ejecutables personalizados) ejecutados bajo la identidad Linux local autorizada.
- Monitorización de sesiones, procesos, recursos y auditoría.
- Publicación opcional mediante proxy reverso (Caddy) y soporte opcional de contenedores (Docker).
- Despliegue reproducible e idempotente mediante un instalador de una sola línea (`install.sh`).

### Principios Fundamentales
1. **Entorno de desarrollo primero**: Citadel es una estación de trabajo para desarrolladores y agentes de IA. La publicación y despliegue son capacidades accesorias.
2. **Cero dependencias pesadas**: No requiere Kubernetes, microservicios, Redis, colas externas ni bases de datos remotas. Funciona en VPS económicos con 512 MB - 1 GB de RAM.
3. **Resiliencia ante dependencias ausentes**: Si `tmux`, `caddy`, `docker` o un agente CLI no están instalados, el núcleo se degrada limpiamente y sigue funcionando.
4. **Seguridad por diseño**:
   - Escucha en `127.0.0.1` por defecto.
   - Cookies de sesión `HttpOnly` y `SameSite=Strict`.
   - Validación de origen en WebSockets.
   - Prevención estricta de Path Traversal mediante resolución canónica.
   - Ejecución estructurada de procesos (`spawn` con arrays de argumentos), evitando interpolación en shell.
   - Registro inicial obligatorio de cuenta administradora sin contraseñas predeterminadas.

---

## 2. Diagrama de Arquitectura de Capas

```
+-----------------------------------------------------------------+
|                       Frontend Web (SPA)                       |
|   Dashboard | Projects | Terminal (xterm.js) | Agents | System  |
+-----------------------------------------------------------------+
                                | HTTP REST & WebSockets
                                v
+-----------------------------------------------------------------+
|                    Fastify Core & Middleware                   |
|   Rate Limiter | Helmet | Session Auth | CSRF/Origin Guard      |
+-----------------------------------------------------------------+
        |                        |                       |
        v                        v                       v
+---------------+        +---------------+       +---------------+
|  HTTP Routes  |        |  WS Terminal  |       | Plugin Loader |
| /api/auth     |        | /ws/terminal  |       | plugin.json   |
| /api/projects |        +---------------+       +---------------+
| /api/agents   |                |
| /api/git      |                v
| /api/proxy    |        +-------------------------------+
| /api/system   |        | Session & Terminal Manager   |
+---------------+        | (node-pty + tmux attach/spawn)|
        |                +-------------------------------+
        v
+-----------------------------------------------------------------+
|                       Capa de Servicios                         |
| ProjectService | AgentRegistry | GitService | ProxyProvider     |
| DockerService  | AuditLogger   | NodeService (Local / Remote)   |
+-----------------------------------------------------------------+
        |                                        |
        v                                        v
+-----------------------+              +--------------------------+
| SQLite (better-sqlite3)|              | Host Linux OS            |
| data/citadel.db       |              | - Proyectos (/srv/...)   |
| WAL mode              |              | - tmux sessions          |
+-----------------------+              | - CLI agents / binaries  |
                                       +--------------------------+
```

---

## 3. Modelo de Datos (SQLite)

1. **`users`**: ID, username, password_hash, salt, role, created_at, updated_at.
2. **`sessions`**: ID (token de 256 bits), user_id, expires_at, created_at, last_active.
3. **`projects`**: ID, name, slug, description, path, git_remote, git_branch, created_at, updated_at.
4. **`term_sessions`**: ID, project_id, name, tmux_session, agent_id, status, created_at, last_active.
5. **`audit_logs`**: ID, user_id, action, target_type, target_id, details, ip, created_at.
6. **`deployments`**: ID, project_id, domain, target_port, status, ssl_active, created_at.
7. **`plugins`**: ID, name, version, enabled, config, created_at.

> Nota: el identificador de sesión se almacena directamente en la tabla `sessions`; no se aplica hashing adicional porque ya es un valor aleatorio de 256 bits que el cliente solo conoce a través de una cookie `HttpOnly`.

---

## 4. Persistencia de Terminales con `tmux`

- Cada proyecto puede abrir múltiples terminales.
- Cada terminal se vincula a una sesión `tmux` identificada de forma determinista y segura: `citadel_<project_slug>_<session_id>`.
- `node-pty` ejecuta `tmux new-session -A -s citadel_<project_slug>_<session_id>` con el directorio de trabajo del proyecto.
- Si el navegador se desconecta y vuelve a conectarse, se reconecta al mismo PTY o reanuda la sesión tmux sin perder el estado ni matar procesos en curso.
- Si `tmux` no está instalado en el sistema operativo, el gestor utiliza `node-pty` en modo directo y notifica al usuario que instale `tmux` para persistencia ante reinicios.

---

## 5. Lanzador de Agentes CLI de IA

El registro de agentes define especificaciones estandarizadas para herramientas como:
- **Claude Code** (`claude`)
- **Codex CLI** (`codex`)
- **OpenCode** (`opencode`)
- **Custom Agent** (configurado por el administrador)

Cada agente se detecta inspeccionando rutas seguras y `PATH`. Se ejecuta en una terminal dedicada dentro del directorio del proyecto seleccionado, aprovechando la configuración y credenciales del usuario Linux del servidor sin exponer secretos al navegador.

El binario y cada argumento se citan individualmente (`shellQuote`) antes de escribirse en el PTY, por lo que los argumentos extra suministrados por el navegador no pueden inyectar comandos adicionales.

---

## 6. Aislamiento Real y Limitaciones

Citadel proporciona **separación lógica** entre proyectos: cada proyecto tiene su propio directorio, sus propias sesiones de terminal y su propio registro de despliegues. Sin embargo, conviene entender su alcance real de aislamiento:

- **Un único usuario Linux**: todos los proyectos, terminales y agentes se ejecutan bajo el mismo usuario del sistema (el usuario `citadel.service`, o el usuario que ejecute el servidor). **No existe aislamiento a nivel de sistema operativo** (sin contenedores, `chroot`, namespaces ni distintos UID) entre proyectos. Un proyecto puede, en principio, leer o modificar los archivos de otro proyecto al que ese usuario tenga acceso.
- **Terminal equivalente a un shell del usuario del servicio**: obtener una terminal en el panel equivale a obtener un shell interactivo con los privilegios de la cuenta que ejecuta Citadel. Por defecto esa cuenta **no es root** y el servicio no concede privilegios elevados; ejecutar el servidor como `root` daría lugar a una terminal `root`.
- **Validación de rutas**: el directorio de una terminal ad-hoc enviado por el cliente y el borrado recursivo de archivos de proyecto se validan contra el árbol gestionado (`PROJECTS_DIR`). La operación de *importar* un proyecto permite registrar deliberadamente cualquier directorio del host elegido por el administrador (es una función intencional, no una vulnerabilidad, y requiere autenticación).
- **Validación de origen WebSocket**: las conexiones sin cabecera `Origin` (clientes no navegador, scripts) se aceptan, pero en todos los casos se exige una sesión autenticada válida mediante cookie o token.
- **Integraciones opcionales**: Caddy y Docker solo se consultan cuando están disponibles localmente. La API administrativa de Caddy debe permanecer escuchando en `127.0.0.1:2019` y nunca exponerse públicamente; Docker se accede únicamente a través del socket Unix local y de solo lectura para inspección.
- **Sin garantía absoluta de seguridad**: Citadel reduce la superficie de exposición mediante cookies `HttpOnly`/`SameSite=Strict`, validación de origen, límite de peticiones, cabeceras de seguridad y ejecución estructurada de procesos, pero no sustituye a una revisión de seguridad específica de cada despliegue.
