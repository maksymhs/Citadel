# NexusVPS

Plataforma web autohospedada, ultraligera, modular y segura para gestionar múltiples proyectos de software, terminales persistentes y agentes de programación CLI en uno o varios VPS.

---

## 1. Características Principales

- **Gestión Unificada de Proyectos**: Registra, crea, importa y clona repositorios Git con verificación de estado y ramas en tiempo real.
- **Terminales Persistentes con tmux**: Terminal web integrada con `xterm.js`, `node-pty` y `tmux`. Tus procesos y sesiones continúan ejecutándose aunque cierres el navegador o se reinicie el panel.
- **Lanzador de Agentes CLI de IA**: Detección y ejecución directa de herramientas CLI de IA como **Claude Code**, **Codex CLI**, **OpenCode** y binarios personalizados bajo la cuenta Linux autorizada del servidor, sin requerir APIs comerciales ni exponer secretos.
- **Bajo Consumo de Recursos**: Arquitectura optimizada con Fastify y SQLite en modo WAL (~57 MB RAM en reposo), apta para VPS desde 512 MB.
- **Seguridad por Diseño**:
  - Escucha local en `127.0.0.1` por defecto.
  - Autenticación obligatoria con cookies `HttpOnly`, `SameSite=Strict`.
  - Validación de origen en WebSockets y prevención estricta de Path Traversal.
  - Registro de auditoría con enmascaramiento automático de credenciales.
- **Publicación de Dominios (Opcional)**: Integración con Caddy mediante su API administrativa local para proxy reverso y HTTPS automático con Let's Encrypt.
- **Monitorización Docker (Opcional)**: Inspección de contenedores mediante socket Unix protegido. El núcleo funciona al 100% sin Docker ni Caddy.
- **Sistema de Plugins**: Manifiestos estandarizados `plugin.json` con aislamiento de fallos para que ningún plugin pueda colapsar el núcleo.
- **Instalación Idempotente**: Instalador `install.sh` y unidad systemd para Debian/Ubuntu y entornos POSIX.

---

## 2. Requisitos del Sistema

- **Sistema Operativo**: Debian 11/12, Ubuntu 20.04/22.04/24.04 (o macOS para desarrollo local).
- **Arquitectura**: `x86_64` o `arm64 / aarch64`.
- **Node.js**: v18 LTS, v20 LTS, v22 LTS o superior.
- **tmux**: Para persistencia completa de sesiones (opcional: PTY directo como fallback).
- **Git**: CLI nativa instalada en el sistema.
- **Memoria RAM**: Mínimo 512 MB (recomendado 1 GB para agentes de IA).

---

## 3. Instalación Rápida

### En un VPS (Debian / Ubuntu)

Ejecuta el instalador idempotente:

```bash
git clone https://github.com/tu-usuario/nexusvps.git /srv/nexusvps/app
cd /srv/nexusvps/app
./install.sh
```

El instalador:
1. Comprueba el sistema operativo, memoria y dependencias.
2. Instala Node.js y compiladores si es necesario.
3. Prepara la estructura en `/srv/nexusvps` (`app`, `data`, `projects`, `logs`).
4. Configura el servicio `nexusvps.service` en systemd y lo arranca.

### Comprobación Previa (Dry-Run)

```bash
./install.sh --check-only
```

---

## 4. Ejecución en Modo Desarrollo

```bash
# 1. Instalar dependencias y copiar bundles locales de xterm
npm install

# 2. Ejecutar diagnóstico de salud del sistema
npm run doctor

# 3. Ejecutar suite completa de pruebas automatizadas
npm test

# 4. Iniciar servidor en modo desarrollo
npm run dev
# O en producción:
npm start
```

Abre tu navegador en `http://127.0.0.1:3000`.

---

## 5. Estructura del Repositorio

```
nexusvps/
├── server/               # Backend en Node.js + Fastify
│   ├── config.js         # Configuración y variables de entorno
│   ├── index.js          # Arranque del servidor y middleware
│   ├── database/         # SQLite embebido con WAL
│   ├── security/         # Auth, sesiones, cookies, path traversal
│   ├── services/         # Proyectos, terminales (tmux/pty), agentes, git, proxy, docker
│   └── routes/           # Endpoints HTTP REST y WebSockets (/ws/terminal)
├── public/               # Frontend SPA (HTML5, CSS responsive oscuro, JS modular)
│   ├── css/app.css       # Estilos propios sin dependencias externas
│   ├── js/app.js         # Lógica SPA, xterm, WebSockets, modales
│   └── vendor/           # Bundles locales de xterm.js (0 CDNs)
├── plugins/              # Plugins oficiales (plugin.json)
├── scripts/              # Scripts de mantenimiento
│   ├── copy-vendor.js    # Copia assets de xterm y asigna permisos +x
│   ├── doctor.js         # Diagnóstico de salud y dependencias
│   ├── update.sh         # Actualizador seguro (conserva datos y repos)
│   ├── uninstall.sh      # Desinstalador controlado
│   └── nexusvps.service  # Unidad systemd para Linux
├── tests/                # Pruebas automatizadas (32 pruebas, 8 suites)
├── docs/                 # Documentación de arquitectura y ADRs
├── install.sh            # Instalador principal
└── package.json
```

---

## 6. Diagnóstico y Mantenimiento

```bash
# Diagnóstico completo de componentes y dependencias
node scripts/doctor.js

# Actualizar aplicación preservando datos y proyectos
./scripts/update.sh

# Desinstalar preservando datos por defecto
./scripts/uninstall.sh
```

---

## 7. Licencia

Apache-2.0
