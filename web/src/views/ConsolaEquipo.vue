<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import ModalCodigo from '../componentes/ModalCodigo.vue';
import { ETIQUETA_ROL_OP, fecha, fechaHora } from '../format';

interface Op { id: string; email: string; nombre: string; rol: 'admin' | 'soporte' | 'finanzas'; activo: boolean; pendiente: boolean; bloqueadoHasta: string | null; creado: string; invitacionExpira: string | null; ultimoAcceso: string | null }
type Tipo = 'invitar' | 'reenviar' | 'desactivar' | 'reactivar' | 'rol';
const lista = ref<Op[]>([]); const yo = ref(''); const bitacora = ref<Array<{ cuando: string; quien: string; accion: string; detalle: string }>>([]);
const error = ref(''); const aviso = ref(''); const enlaceDePrueba = ref('');
const accion = ref<{ tipo: Tipo; op?: Op } | null>(null); const errModal = ref(''); const ocupado = ref(false);
const nuevoEmail = ref(''); const nuevoNombre = ref(''); const nuevoRol = ref<'admin' | 'soporte' | 'finanzas'>('soporte'); const rolSel = ref<'admin' | 'soporte' | 'finanzas'>('soporte');

async function cargar() {
  try {
    const r = await api<{ operadores: Op[]; yo: string }>('GET', '/api/consola/equipo');
    lista.value = r.operadores; yo.value = r.yo;
    bitacora.value = await api('GET', '/api/consola/equipo/bitacora');
  } catch (e) { error.value = mensajeError(e); }
}
onMounted(cargar);
function abrir(tipo: Tipo, op?: Op) { errModal.value = ''; aviso.value = ''; enlaceDePrueba.value = ''; if (tipo === 'rol' && op) rolSel.value = op.rol; accion.value = { tipo, op }; }
const estado = (o: Op) => (o.pendiente ? 'Pendiente de activar' : !o.activo ? 'Desactivado' : o.bloqueadoHasta ? 'Bloqueado un rato' : 'Activo');
const claseEstado = (o: Op) => (o.pendiente ? 'e-prueba' : !o.activo ? 'e-sin_saldo' : 'e-activo');
const TITULO: Record<Tipo, string> = { invitar: 'Invitar a una persona al equipo', reenviar: 'Reenviar invitación', desactivar: 'Desactivar a una persona', reactivar: 'Reactivar a una persona', rol: 'Cambiar el rol' };
const peligro = computed(() => accion.value?.tipo === 'desactivar');

async function confirmar(codigo: string) {
  errModal.value = ''; ocupado.value = true;
  const a = accion.value!; const base = '/api/consola/equipo';
  try {
    let r: { invitacion?: { enviada: boolean; enlace?: string }; enviada?: boolean; enlace?: string } = {};
    if (a.tipo === 'invitar') r = await api('POST', base, { email: nuevoEmail.value, nombre: nuevoNombre.value, rol: nuevoRol.value, codigo });
    else if (a.tipo === 'reenviar') r = await api('POST', `${base}/${a.op!.id}/reenviar-invitacion`, { codigo });
    else if (a.tipo === 'rol') await api('POST', `${base}/${a.op!.id}/rol`, { rol: rolSel.value, codigo });
    else await api('POST', `${base}/${a.op!.id}/estado`, { activo: a.tipo === 'reactivar', codigo });
    const env = r.invitacion ?? r;
    enlaceDePrueba.value = env.enlace ?? '';
    aviso.value = (a.tipo === 'invitar' || a.tipo === 'reenviar') && env.enviada === false
      ? 'La invitación quedó creada pero no pudimos enviar el correo. Usa "Reenviar invitación" en unos minutos.' : 'Hecho. Avisamos por correo a las personas administradoras.';
    if (a.tipo === 'invitar') { nuevoEmail.value = ''; nuevoNombre.value = ''; }
    accion.value = null; await cargar();
  } catch (e) { errModal.value = mensajeError(e); } finally { ocupado.value = false; }
}
</script>

<template>
  <header class="encabezado">
    <h1 class="titulo">Equipo de <em>Archie</em></h1>
    <button class="btn" type="button" @click="abrir('invitar')">Invitar a una persona</button>
  </header>
  <p class="sec">Aquí invitas, activas y desactivas a las personas que entran a esta consola. Cada una usa su propia contraseña y su propio segundo factor. Cada cambio te pide un código nuevo y avisa por correo a las personas administradoras.</p>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>
  <p v-if="enlaceDePrueba" class="aviso alerta">Solo en desarrollo, el correo no sale: <span class="mono" style="word-break:break-all;user-select:all">{{ enlaceDePrueba }}</span></p>

  <section class="card tabla-caja" aria-label="Personas del equipo">
    <table class="tabla" style="min-width:820px">
      <thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th></th></tr></thead>
      <tbody>
        <tr v-for="o in lista" :key="o.id">
          <td><b>{{ o.nombre }}</b><span v-if="o.id === yo" class="sec"> · tú</span><div class="sec" style="font-size:15px">{{ o.email }}</div></td>
          <td>{{ ETIQUETA_ROL_OP[o.rol] }}</td>
          <td><span class="est" :class="claseEstado(o)">{{ estado(o) }}</span><div v-if="o.pendiente && o.invitacionExpira" class="sec" style="font-size:14px">Invitación hasta el {{ fecha(o.invitacionExpira) }}</div></td>
          <td>{{ o.ultimoAcceso ? fechaHora(o.ultimoAcceso) : '—' }}</td>
          <td><div style="display:flex;gap:8px;flex-wrap:wrap">
            <template v-if="o.id !== yo">
              <button v-if="o.pendiente" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="abrir('reenviar', o)">Reenviar invitación</button>
              <button v-if="!o.pendiente" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="abrir('rol', o)">Cambiar rol</button>
              <button v-if="!o.pendiente && o.activo" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="abrir('desactivar', o)">Desactivar</button>
              <button v-if="!o.pendiente && !o.activo" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="abrir('reactivar', o)">Reactivar</button>
            </template>
          </div></td>
        </tr>
      </tbody>
    </table>
  </section>
  <p class="sec" style="font-size:16px">Si alguien pierde su teléfono, quien administra el servidor debe restablecer su segundo factor con el comando <span class="mono">regenerar-2fa-operador</span> (no se hace desde esta pantalla, a propósito).</p>

  <section class="card tabla-caja" aria-labelledby="be">
    <h2 id="be" class="sub" style="padding:20px 24px 12px">Bitácora del <em>equipo</em></h2>
    <table class="tabla">
      <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué hizo</th></tr></thead>
      <tbody><tr v-for="(b, i) in bitacora" :key="i"><td>{{ fechaHora(b.cuando) }}</td><td>{{ b.quien }}</td><td>{{ b.detalle }}</td></tr>
        <tr v-if="!bitacora.length"><td colspan="3" class="sec">Todavía no hay cambios en el equipo.</td></tr></tbody>
    </table>
  </section>

  <ModalCodigo v-if="accion" :titulo="TITULO[accion.tipo]" :ocupado="ocupado" :error="errModal" :peligro="peligro" @confirmar="confirmar" @cancelar="accion = null">
    <template v-if="accion.tipo === 'invitar'">
      <div class="form">
        <div class="campo-grupo"><label class="etq" for="ie">Correo</label><input id="ie" v-model="nuevoEmail" class="campo" type="email" autocomplete="off" maxlength="320"></div>
        <div class="campo-grupo"><label class="etq" for="in">Nombre</label><input id="in" v-model="nuevoNombre" class="campo" maxlength="120"></div>
        <div class="campo-grupo"><label class="etq" for="ir">Rol</label><select id="ir" v-model="nuevoRol" class="campo"><option value="soporte">Soporte</option><option value="finanzas">Finanzas</option><option value="admin">Administración</option></select>
          <p class="ayuda">La persona recibe un correo, crea su contraseña y activa su segundo factor. Tú nunca ves ni eliges sus claves.</p></div>
      </div>
    </template>
    <p v-else-if="accion.tipo === 'reenviar'">Enviar una invitación nueva a <b>{{ accion.op?.email }}</b>. El enlace anterior deja de servir.</p>
    <p v-else-if="accion.tipo === 'desactivar'">Desactivar a <b>{{ accion.op?.nombre }}</b> ({{ accion.op?.email }}). Se cierran sus sesiones al instante, incluida su sesión en Mi cuenta, y no podrá entrar.</p>
    <p v-else-if="accion.tipo === 'reactivar'">Reactivar a <b>{{ accion.op?.nombre }}</b>. Podrá entrar de nuevo con su contraseña y su segundo factor.</p>
    <div v-else class="campo-grupo"><label class="etq" for="rs">Rol de {{ accion.op?.nombre }}</label><select id="rs" v-model="rolSel" class="campo"><option value="soporte">Soporte</option><option value="finanzas">Finanzas</option><option value="admin">Administración</option></select>
      <p class="ayuda">Se cierran sus sesiones abiertas para que el cambio sea inmediato. Debe quedar al menos una persona administradora activa.</p></div>
  </ModalCodigo>
</template>
