<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { fecha, fechaHora } from '../format';

interface Miembro { id: string; email: string; nombre: string | null; rol: 'admin' | 'miembro'; totpActivo: boolean; activo: boolean; yo: boolean }
interface Invitacion { id: string; email: string; rol: 'admin' | 'miembro'; creada: string; expira: string; estado: 'pendiente' | 'vencida' | 'aceptada' | 'revocada' }
interface Datos { miembros: Miembro[]; invitaciones: Invitacion[]; puedeAdministrar: boolean }
interface Envio { enviado: boolean; enlace?: string }

const filas = ref<Array<{ cuando: string; quien: string; accion: string; detalle: string }> | null>(null);
const d = ref<Datos | null>(null);
const error = ref(''); const aviso = ref(''); const enlaceDePrueba = ref('');
const email = ref(''); const rol = ref<'admin' | 'miembro'>('miembro'); const ocupado = ref(false);

async function cargar() {
  try { d.value = await api<Datos>('GET', '/api/panel/equipo'); } catch (e) { error.value = mensajeError(e); }
}
onMounted(async () => {
  void cargar();
  try { filas.value = await api('GET', '/api/panel/bitacora-equipo'); } catch (e) { error.value = mensajeError(e); }
});

const pendientes = computed(() => d.value?.invitaciones.filter((i) => i.estado === 'pendiente' || i.estado === 'vencida') ?? []);
const ETQ_ESTADO: Record<string, string> = { pendiente: 'Pendiente', vencida: 'Vencida', aceptada: 'Aceptada', revocada: 'Revocada' };

function resultado(r: Envio, a: string) {
  enlaceDePrueba.value = r.enlace ?? '';
  aviso.value = r.enviado ? `${a} Le llegará un correo con un enlace que sirve una vez y vence en 7 días.` : `${a} No pudimos enviar el correo: usa «Reenviar» en unos minutos.`;
}
async function accion(f: () => Promise<void>) {
  error.value = ''; aviso.value = ''; enlaceDePrueba.value = ''; ocupado.value = true;
  try { await f(); await cargar(); } catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; }
}
const invitar = () => accion(async () => {
  const r = await api<Envio>('POST', '/api/panel/equipo/invitaciones', { email: email.value, rol: rol.value });
  resultado(r, `Invitamos a ${email.value}.`); email.value = '';
});
const reenviar = (i: Invitacion) => accion(async () => resultado(await api<Envio>('POST', `/api/panel/equipo/invitaciones/${i.id}/reenviar`, {}), `Reenviamos la invitación a ${i.email}.`));
const revocar = (i: Invitacion) => accion(async () => { await api('POST', `/api/panel/equipo/invitaciones/${i.id}/revocar`, {}); aviso.value = `Revocamos la invitación de ${i.email}.`; });
const cambiarRol = (m: Miembro, nuevo: string) => accion(async () => { await api('POST', `/api/panel/equipo/miembros/${m.id}`, { rol: nuevo }); aviso.value = `Cambiamos el rol de ${m.email}. Si estaba conectado, tendrá que entrar de nuevo.`; });
const activar = (m: Miembro, activo: boolean) => accion(async () => { await api('POST', `/api/panel/equipo/miembros/${m.id}`, { activo }); aviso.value = activo ? `${m.email} puede entrar otra vez.` : `${m.email} ya no puede entrar y se cerraron sus sesiones.`; });
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Equipo y <em>bitácora</em></h1></header>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>
  <p v-if="enlaceDePrueba" class="aviso alerta">Solo en desarrollo, el correo no sale: <span class="mono" style="word-break:break-all;user-select:all">{{ enlaceDePrueba }}</span></p>

  <section v-if="d" class="card tabla-caja" aria-labelledby="eq">
    <h2 id="eq" class="sub" style="padding:20px 24px 12px">Tu <em>equipo</em></h2>
    <table class="tabla">
      <thead><tr><th>Persona</th><th>Rol</th><th>2 pasos</th><th>Estado</th><th v-if="d.puedeAdministrar"><span class="solo-lector">Acciones</span></th></tr></thead>
      <tbody>
        <tr v-for="m in d.miembros" :key="m.id">
          <td>{{ m.email }}<span v-if="m.nombre" class="sec"> · {{ m.nombre }}</span><span v-if="m.yo" class="sec"> (tú)</span></td>
          <td>
            <template v-if="d.puedeAdministrar && !m.yo">
              <label class="solo-lector" :for="'r' + m.id">Rol de {{ m.email }}</label>
              <select :id="'r' + m.id" class="campo" style="min-height:40px;font-size:16px" :value="m.rol" :disabled="ocupado" @change="cambiarRol(m, ($event.target as HTMLSelectElement).value)">
                <option value="admin">Administrador</option><option value="miembro">Miembro</option>
              </select>
            </template>
            <template v-else>{{ m.rol === 'admin' ? 'Administrador' : 'Miembro' }}</template>
          </td>
          <td>{{ m.totpActivo ? 'Activa' : 'No' }}</td>
          <td>{{ m.activo ? 'Activo' : 'Desactivado' }}</td>
          <td v-if="d.puedeAdministrar">
            <button v-if="!m.yo" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" :disabled="ocupado" @click="activar(m, !m.activo)">{{ m.activo ? 'Desactivar' : 'Reactivar' }}</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="sec" style="padding:12px 24px 20px;font-size:16px">Los administradores pueden invitar personas y cambiar roles. Los miembros usan el asistente pero no administran la cuenta. Siempre queda al menos un administrador.</p>
  </section>

  <section v-if="d?.puedeAdministrar" class="card" aria-labelledby="inv">
    <h2 id="inv" class="sub">Invitar a <em>alguien</em></h2>
    <form class="form" style="max-width:560px;margin-top:12px" @submit.prevent="invitar">
      <div class="campo-grupo"><label class="etq" for="ie">Correo</label><input id="ie" v-model="email" class="campo" type="email" required maxlength="320" autocomplete="off"></div>
      <div class="campo-grupo"><label class="etq" for="ir">Rol</label><select id="ir" v-model="rol" class="campo"><option value="miembro">Miembro</option><option value="admin">Administrador</option></select>
        <p class="ayuda">Cada correo pertenece a una sola organización de Archie AI.</p></div>
      <button class="btn" type="submit" :disabled="ocupado">Enviar invitación</button>
    </form>
  </section>

  <section v-if="d && pendientes.length" class="card tabla-caja" aria-labelledby="pe">
    <h2 id="pe" class="sub" style="padding:20px 24px 12px">Invitaciones <em>pendientes</em></h2>
    <table class="tabla">
      <thead><tr><th>Correo</th><th>Rol</th><th>Vence</th><th>Estado</th><th v-if="d.puedeAdministrar"><span class="solo-lector">Acciones</span></th></tr></thead>
      <tbody><tr v-for="i in pendientes" :key="i.id">
        <td>{{ i.email }}</td><td>{{ i.rol === 'admin' ? 'Administrador' : 'Miembro' }}</td><td>{{ fecha(i.expira) }}</td><td>{{ ETQ_ESTADO[i.estado] }}</td>
        <td v-if="d.puedeAdministrar"><div class="chips">
          <button class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" :disabled="ocupado" @click="reenviar(i)">Reenviar</button>
          <button class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" :disabled="ocupado" @click="revocar(i)">Revocar</button>
        </div></td>
      </tr></tbody>
    </table>
  </section>

  <p class="aviso info">Aquí también ves todo lo que el equipo de Archie Tech hizo en tu cuenta, con el nombre de quien lo hizo. Nadie entra como tú: usamos acciones acotadas y todas quedan registradas.</p>
  <section v-if="filas" class="card tabla-caja" aria-labelledby="b">
    <h2 id="b" class="sub" style="padding:20px 24px 12px">Acciones de <em>Archie Tech</em></h2>
    <table class="tabla">
      <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué hizo</th></tr></thead>
      <tbody>
        <tr v-for="(f, i) in filas" :key="i"><td>{{ fechaHora(f.cuando) }}</td><td>{{ f.quien }}</td><td>{{ f.detalle }}</td></tr>
        <tr v-if="!filas.length"><td colspan="3" class="sec">Todavía no hay acciones del equipo en tu cuenta.</td></tr>
      </tbody>
    </table>
  </section>
</template>
