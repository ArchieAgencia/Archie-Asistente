import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cargarLlaves, cifrar, hashToken } from '../src/crypto.js';
import { conOrg } from '../src/db/pool.js';
import { migrar } from '../src/db/migrar.js';
import { ADMIN_URL, MIGRACIONES, prepararBdPrueba, type BdPrueba } from './bd.js';

const hay = Boolean(ADMIN_URL);
const llaves = cargarLlaves({ ARCHIE_CLAVES_MAESTRAS: `1:${Buffer.alloc(32, 7).toString('base64')}`, ARCHIE_CLAVE_ACTIVA: '1' });

describe.skipIf(!hay)('base de datos: aislamiento entre organizaciones', () => {
  let bd: BdPrueba;
  const A = randomUUID(), B = randomUUID();
  const uA = randomUUID(), uB = randomUUID();
  const tokenA = 'token-de-a', tokenB = 'token-de-b';

  async function sembrar(org: string, uid: string, email: string, token: string) {
    await conOrg(bd.owner, org, async (c) => {
      await c.query('INSERT INTO organizaciones (id, nombre) VALUES ($1, $2)', [org, `Org ${email}`]);
      await c.query('INSERT INTO usuarios (id, org_id, email, password_hash, rol) VALUES ($1,$2,$3,$4,$5)',
        [uid, org, email, 'scrypt$x', 'admin']);
      await c.query('INSERT INTO sesiones (org_id, usuario_id, token_hash, expira_en) VALUES ($1,$2,$3, now() + interval \'1 hour\')',
        [org, uid, hashToken(token)]);
      const s = cifrar(llaves, `secreto-${email}`, org, 'send');
      await c.query('INSERT INTO credenciales_conector (org_id, conector, nombre, secreto, clave_version) VALUES ($1,$2,$3,$4,$5)',
        [org, 'send', 'principal', s.datos, s.version]);
      await c.query('INSERT INTO uso_ia (org_id, usuario_id, modelo, tokens_entrada, tokens_salida) VALUES ($1,$2,$3,10,5)',
        [org, uid, 'modelo-x']);
      await c.query("INSERT INTO auditoria (org_id, usuario_id, accion) VALUES ($1,$2,'prueba')", [org, uid]);
    });
  }

  beforeAll(async () => {
    bd = await prepararBdPrueba();
    await sembrar(A, uA, 'a@ejemplo.test', tokenA);
    await sembrar(B, uB, 'b@ejemplo.test', tokenB);
  }, 60_000);
  afterAll(async () => { await bd?.cerrar(); });

  const tablas = ['organizaciones', 'usuarios', 'sesiones', 'credenciales_conector', 'uso_ia', 'auditoria'];

  it('el rol de la aplicación no es superusuario ni omite la seguridad por filas', async () => {
    const r = await bd.app.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('todas las tablas tienen seguridad por filas activa y forzada', async () => {
    const r = await bd.owner.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1)", [tablas]);
    expect(r.rows).toHaveLength(tablas.length);
    for (const f of r.rows) expect(f).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it.each(tablas)('cada organización ve solo lo suyo en %s', async (t) => {
    const col = t === 'organizaciones' ? 'id' : 'org_id';
    const a = await conOrg(bd.app, A, (c) => c.query(`SELECT ${col} AS o FROM ${t}`));
    const b = await conOrg(bd.app, B, (c) => c.query(`SELECT ${col} AS o FROM ${t}`));
    expect(a.rows.length).toBeGreaterThan(0);
    expect(a.rows.every((f) => f.o === A)).toBe(true);
    expect(b.rows.every((f) => f.o === B)).toBe(true);
  });

  it.each(tablas)('sin organización fijada no se ve nada en %s (falla cerrado)', async (t) => {
    const r = await bd.app.query(`SELECT 1 FROM ${t}`);
    expect(r.rowCount).toBe(0);
  });

  it('no se puede escribir una fila de otra organización', async () => {
    await expect(conOrg(bd.app, A, (c) =>
      c.query("INSERT INTO auditoria (org_id, accion) VALUES ($1, 'intruso')", [B]))).rejects.toThrow();
    const r = await conOrg(bd.app, A, (c) => c.query('UPDATE usuarios SET rol = $1 WHERE id = $2', ['miembro', uB]));
    expect(r.rowCount).toBe(0); // la fila de B es invisible para A
  });

  it('la sesión y el usuario deben ser de la misma organización', async () => {
    await expect(conOrg(bd.owner, A, (c) =>
      c.query("INSERT INTO sesiones (org_id, usuario_id, token_hash, expira_en) VALUES ($1,$2,$3, now() + interval '1 hour')",
        [A, uB, hashToken('cruzado')]))).rejects.toThrow();
  });

  it('auditoría y uso son de solo agregar para la aplicación', async () => {
    await expect(conOrg(bd.app, A, (c) => c.query("UPDATE auditoria SET accion = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(conOrg(bd.app, A, (c) => c.query('DELETE FROM auditoria'))).rejects.toThrow(/permission denied/);
    await expect(conOrg(bd.app, A, (c) => c.query('DELETE FROM uso_ia'))).rejects.toThrow(/permission denied/);
  });

  it('el secreto guardado está cifrado en la base', async () => {
    const r = await conOrg(bd.app, A, (c) => c.query('SELECT secreto FROM credenciales_conector'));
    expect((r.rows[0].secreto as Buffer).toString('utf8')).not.toContain('secreto-a@ejemplo.test');
  });

  it('el correo se guarda en minúsculas y es único en todo el sistema', async () => {
    await expect(conOrg(bd.owner, A, (c) =>
      c.query('INSERT INTO usuarios (org_id, email, password_hash, rol) VALUES ($1,$2,$3,$4)', [A, 'Mayus@Ejemplo.test', 'x', 'miembro']))).rejects.toThrow();
    await expect(conOrg(bd.owner, A, (c) =>
      c.query('INSERT INTO usuarios (org_id, email, password_hash, rol) VALUES ($1,$2,$3,$4)', [A, 'b@ejemplo.test', 'x', 'miembro']))).rejects.toThrow();
  });

  it('buscar_usuario_para_login funciona sin organización, pero la aplicación no puede leer usuarios directamente', async () => {
    const f = await bd.app.query('SELECT * FROM buscar_usuario_para_login($1)', ['A@Ejemplo.test']);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({ id: uA, org_id: A, activo: true });
    expect((await bd.app.query('SELECT * FROM buscar_usuario_para_login($1)', ['nadie@ejemplo.test'])).rowCount).toBe(0);
    expect((await bd.app.query('SELECT * FROM usuarios')).rowCount).toBe(0);
  });

  it('resolver_sesion: válida, token ajeno, vencida y usuario desactivado', async () => {
    const ok = await bd.app.query('SELECT * FROM resolver_sesion($1)', [hashToken(tokenA)]);
    expect(ok.rows[0]).toMatchObject({ usuario_id: uA, org_id: A, rol: 'admin' });
    expect((await bd.app.query('SELECT * FROM resolver_sesion($1)', [hashToken('inventado')])).rowCount).toBe(0);

    await conOrg(bd.owner, B, (c) => c.query("UPDATE sesiones SET expira_en = now() - interval '1 minute'"));
    expect((await bd.app.query('SELECT * FROM resolver_sesion($1)', [hashToken(tokenB)])).rowCount).toBe(0);

    await conOrg(bd.owner, A, (c) => c.query('UPDATE usuarios SET activo = false WHERE id = $1', [uA]));
    expect((await bd.app.query('SELECT * FROM resolver_sesion($1)', [hashToken(tokenA)])).rowCount).toBe(0);
    await conOrg(bd.owner, A, (c) => c.query('UPDATE usuarios SET activo = true WHERE id = $1', [uA]));
  });

  it('registrar_login_fallido bloquea la cuenta al llegar al máximo', async () => {
    const estado = async () =>
      (await bd.app.query('SELECT bloqueado_hasta FROM buscar_usuario_para_login($1)', ['a@ejemplo.test'])).rows[0].bloqueado_hasta;
    for (let i = 0; i < 2; i++) await bd.app.query('SELECT registrar_login_fallido($1, 3, 15)', [uA]);
    expect(await estado()).toBeNull();
    await bd.app.query('SELECT registrar_login_fallido($1, 3, 15)', [uA]);
    expect(await estado()).not.toBeNull();
  });

  it('toda función SECURITY DEFINER tiene pg_temp al final de su search_path', async () => {
    const r = await bd.owner.query(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c ~ '^search_path=.*pg_temp$')`);
    expect(r.rows).toEqual([]);
  });

  it('reservar_intento_login: cuenta de forma atómica, reinicia tras vencer el bloqueo y liberar devuelve la reserva', async () => {
    await conOrg(bd.owner, A, (c) => c.query('UPDATE usuarios SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id = $1', [uA]));
    {
      const q = (sql: string, p: unknown[] = []) => bd.app.query(sql, p);
      const rs = await Promise.all(Array.from({ length: 20 }, () => q('SELECT reservar_intento_login($1,5,15) AS ok', [uA])));
      expect(rs.filter((x) => x.rows[0].ok).length).toBe(5);
      await conOrg(bd.owner, A, (c) => c.query("UPDATE usuarios SET bloqueado_hasta = now() - interval '1 second' WHERE id = $1", [uA]));
      expect((await q('SELECT reservar_intento_login($1,5,15) AS ok', [uA])).rows[0].ok).toBe(true);
      const f = await conOrg(bd.owner, A, (c) => c.query('SELECT intentos_fallidos, bloqueado_hasta FROM usuarios WHERE id = $1', [uA]));
      expect(f.rows[0].intentos_fallidos).toBe(1);
      expect(f.rows[0].bloqueado_hasta).toBeNull();
      await q('SELECT liberar_intento_login($1,5)', [uA]);
      const g = await conOrg(bd.owner, A, (c) => c.query('SELECT intentos_fallidos FROM usuarios WHERE id = $1', [uA]));
      expect(g.rows[0].intentos_fallidos).toBe(0);
    }
  });

  it('las migraciones se pueden repetir y detectan cambios en una ya aplicada', async () => {
    expect(await migrar(bd.owner, MIGRACIONES)).toEqual([]);
  });

  it('conOrg rechaza organizaciones con formato inválido (sin tocar la base)', async () => {
    await expect(conOrg(bd.app, "x'; DROP TABLE usuarios;--", async () => 1)).rejects.toThrow('Organización inválida');
  });
});
