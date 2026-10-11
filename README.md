# ActivaUC

Plataforma web para la reserva de espacios deportivos. Permite consultar los recintos disponibles, ver sus bloques horarios con los cupos que quedan y revisar las reservas de cada usuario.

> Estado actual: primeras vistas con datos de prueba. Todavía no hay backend, usuarios ni lógica de reservas.

## Tecnologías

- [React](https://react.dev) 19 con TypeScript
- [Vite](https://vite.dev) como herramienta de desarrollo y build
- [React Router](https://reactrouter.com) para la navegación
- [Tailwind CSS](https://tailwindcss.com) para los estilos
- React Compiler habilitado
- ESLint para el análisis estático del código

## Cómo ejecutarlo

Requiere [Node.js](https://nodejs.org) y [Yarn](https://yarnpkg.com).

```bash
yarn install
yarn dev
```

La aplicación queda disponible en `http://localhost:5173`.

## Scripts

| Comando        | Qué hace                                  |
| -------------- | ----------------------------------------- |
| `yarn dev`     | Inicia el servidor de desarrollo          |
| `yarn build`   | Revisa los tipos y genera la versión final |
| `yarn preview` | Sirve la versión generada para probarla   |
| `yarn lint`    | Ejecuta ESLint                            |

## Vistas

- **Recintos** (`/recintos`): lista de recintos con su información general. Al elegir uno se muestran sus bloques horarios, los cupos disponibles y un botón "Reservar" (todavía sin funcionamiento).
- **Mis reservas** (`/mis-reservas`): reservas del usuario separadas en dos pestañas, "Vigentes" y "Pasadas".

## Estructura del proyecto

```
src/
├── components/   Componentes reutilizables (Navbar)
├── data/         Datos de prueba (mock.ts)
├── pages/        Una página por vista
├── App.tsx       Define las rutas
├── main.tsx      Punto de entrada de la aplicación
└── index.css     Estilos globales y Tailwind
```

## Datos de prueba

Los recintos, bloques y reservas están definidos en `src/data/mock.ts`. Cuando exista el backend, ese archivo se reemplaza por datos reales sin cambiar la forma de las vistas.

## Próximos pasos

- Registro e inicio de sesión de usuarios
- Creación y cancelación de reservas
- Integración con Google Calendar y notificaciones por WhatsApp
- Panel de administración de recintos y bloques