import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { aprovisionar } from '../src/db/aprovisionar.js';
import { crearPool } from '../src/db/pool.js';
import { migrar } from '../src/db/migrar.js';

export const ADMIN_URL = process.env.ARCHIE_TEST_ADMIN_URL;
export const MIGRACIONES = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface BdPrueba {
  nombre: string;
  owner: pg.Pool;
  app: pg.Pool;
  cerrar: () => Promise<void>;
}

export async function prepararBdPrueba(): Promise<BdPrueba> {
  const nombre = `archie_test_${randomBytes(4).toString('hex')}`;
  const claves = { owner: randomBytes(16).toString('hex'), app: randomBytes(16).toString('hex') };
  await aprovisionar(ADMIN_URL!, nombre, claves);
  const base = new URL(ADMIN_URL!);
  const url = (u: string, p: string) => {
    const x = new URL(base);
    x.username = u; x.password = p; x.pathname = `/${nombre}`;
    return x.toString();
  };
  const owner = crearPool(url('archie_owner', claves.owner), 4);
  const app = crearPool(url('archie_app', claves.app), 4);
  await migrar(owner, MIGRACIONES);
  return {
    nombre, owner, app,
    cerrar: async () => {
      await app.end(); await owner.end();
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
      await admin.end();
    },
  };
}
