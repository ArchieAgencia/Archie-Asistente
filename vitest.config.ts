import { defineConfig } from 'vitest/config';

// Las pruebas con base de datos comparten el clúster de PostgreSQL y hacen trabajo de CPU (hash de contraseñas):
// pocos procesos a la vez y tiempos holgados para que los equipos lentos (integración continua) no den falsos fallos.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 3,
    minWorkers: 1,
  },
});
