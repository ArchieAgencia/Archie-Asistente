import pg from 'pg';

export interface ClavesRoles {
  owner: string;
  app: string;
}

const IDENT = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * Crea (o actualiza) los roles y la base de datos. Se ejecuta UNA vez con el administrador de PostgreSQL,
 * nunca desde la aplicación. Las contraseñas llegan por variables de entorno y no se registran.
 */
export async function aprovisionar(adminUrl: string, baseDeDatos: string, claves: ClavesRoles): Promise<void> {
  if (!IDENT.test(baseDeDatos)) throw new Error('Nombre de base inválido');
  if (claves.owner.length < 16 || claves.app.length < 16) throw new Error('Contraseñas de roles demasiado cortas');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Los roles son del clúster: si dos aprovisionamientos corren a la vez (pruebas en paralelo, despliegues simultáneos) se pisan.
    await admin.query('SELECT pg_advisory_lock(727001)');
    const lit = (s: string) => admin.escapeLiteral(s);
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_preauth') THEN CREATE ROLE archie_preauth NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_consola') THEN CREATE ROLE archie_consola NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_invita') THEN CREATE ROLE archie_invita NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_recupera') THEN CREATE ROLE archie_recupera NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_widget') THEN CREATE ROLE archie_widget NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_owner') THEN CREATE ROLE archie_owner LOGIN NOSUPERUSER NOBYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='archie_app') THEN CREATE ROLE archie_app LOGIN NOSUPERUSER NOBYPASSRLS; END IF;
    END $$`);
    await admin.query(`ALTER ROLE archie_owner PASSWORD ${lit(claves.owner)}`);
    await admin.query(`ALTER ROLE archie_app PASSWORD ${lit(claves.app)}`);
    await admin.query('GRANT archie_preauth TO archie_owner'); // permite al dueño asignar las funciones a ese rol (hereda sus permisos: pendiente de endurecer, ver docs/estado)
    // Dueño de las funciones de la consola. Sin herencia: el rol dueño puede asignarle funciones pero NO hereda sus permisos ni sus políticas.
    await admin.query('GRANT archie_consola TO archie_owner WITH INHERIT FALSE, SET TRUE');
    // Dueño de las funciones de invitaciones (ver y aceptar antes de tener sesión). Mismo método: sin herencia.
    await admin.query('GRANT archie_invita TO archie_owner WITH INHERIT FALSE, SET TRUE');
    // Dueño de la función que aplica un enlace de recuperación de contraseña (antes de tener sesión). Sin herencia.
    await admin.query('GRANT archie_recupera TO archie_owner WITH INHERIT FALSE, SET TRUE');
    // Dueño de las funciones del widget embebible (identificar clave, canjear enlace y resolver sesión antes de conocer la organización). Sin herencia.
    await admin.query('GRANT archie_widget TO archie_owner WITH INHERIT FALSE, SET TRUE');
    const existe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [baseDeDatos]);
    if (existe.rowCount === 0) await admin.query(`CREATE DATABASE ${baseDeDatos} OWNER archie_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${baseDeDatos} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${baseDeDatos} TO archie_app, archie_owner`);
  } finally {
    await admin.end();
  }
}
