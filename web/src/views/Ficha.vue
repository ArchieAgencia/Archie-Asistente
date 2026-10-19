<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, mensajeError } from '../api';
import ModalCodigo from '../componentes/ModalCodigo.vue';
import FichaConexiones from './FichaConexiones.vue';
import FichaUso from './FichaUso.vue';
import FichaWidget from './FichaWidget.vue';
import { ETIQUETA_AUTONOMIA, ETIQUETA_ESTADO, ETIQUETA_MODO, fecha, fechaHora, num } from '../format';
import { cargarPlanes, sesion, type PlanListado } from '../store';

interface Ficha {
  id: string; nombre: string; estado: string; modo: 'autoservicio' | 'gestionada'; autonomia: string; creada: string; asistenciaHasta: string | null;
  plan: { id: string; nombre: string; cuota: number; topeDiario: number }; saldo: number; consumidoMes: number; conexiones: number;
  equipo: Array<{ id: string; email: string; nombre: string | null; rol: string; totpActivo: boolean; activo: boolean }>;
  invitaciones: Array<{ email: string; rol: string; creada: string; expira: string; estado: 'pendiente' | 'vencida' | 'aceptada' | 'revocada' }>;
  bitacora: Array<{ cuando: string; quien: string; accion: string; detalle: string }>;
}
type Tipo = 'saldo' | 'plan' | 'estado' | 'modo' | 'autonomia' | 'asistencia' | 'reset' | 'invitacion';

const id = useRoute().params.id as string;
const f = ref<Ficha | null>(null);
const error = ref(''); const aviso = ref(''); const enlaceDePrueba = ref('');
const PLANES = ref<PlanListado[]>([]);
onMounted(() => { cargar(); cargarPlanes().then((p) => { PLANES.value = p; }).catch((e) => { error.value = mensajeError(e); }); });
async function cargar() { try { f.value = await api('GET', `/api/consola/clientes/${id}`); } catch (e) { error.value = mensajeError(e); } }

const rol = computed(() => sesion.operador?.rol);
const puede = (...roles: string[]) => roles.includes(rol.value ?? '');
const asistenciaVigente = computed(() => Boolean(f.value?.asistenciaHasta && new Date(f.value.asistenciaHasta) > new Date()));

// Estado de la acción en curso (formulario dentro del modal de código)
const accion = ref<{ tipo: Tipo; usuarioId?: string; usuarioEmail?: string } | null>(null);
const saldoCantidad = ref(500); const saldoTipo = ref<'recarga' | 'ajuste'>('recarga'); const saldoMotivo = ref('');
const planSel = ref('basico'); const estadoSel = ref('suspendido'); const modoSel = ref<'autoservicio' | 'gestionada'>('gestionada');
const autonomiaSel = ref('borradores'); const horas = ref(24);
const errModal = ref(''); const ocupado = ref(false);

function abrir(tipo: Tipo, extra: { usuarioId?: string; usuarioEmail?: string } = {}, estado?: string) {
  errModal.value = ''; aviso.value = '';
  if (tipo === 'plan') planSel.value = f.value!.plan.id;
  if (tipo === 'estado' && estado) estadoSel.value = estado;
  if (tipo === 'modo') modoSel.value = f.value!.modo === 'gestionada' ? 'autoservicio' : 'gestionada';
  if (tipo === 'autonomia') autonomiaSel.value = f.value!.autonomia;
  accion.value = { tipo, ...extra };
}

function cuerpo(): { url: string; datos: object } {
  const a = accion.value!; const base = `/api/consola/clientes/${id}`;
  switch (a.tipo) {
    case 'saldo': return { url: `${base}/saldo`, datos: { cantidad: Math.trunc(saldoCantidad.value), tipo: saldoTipo.value, ...(saldoMotivo.value ? { motivo: saldoMotivo.value } : {}) } };
    case 'plan': return { url: `${base}/plan`, datos: { plan: planSel.value } };
    case 'estado': return { url: `${base}/estado`, datos: { estado: estadoSel.value } };
    case 'modo': return { url: `${base}/modo`, datos: { modo: modoSel.value } };
    case 'autonomia': return { url: `${base}/autonomia`, datos: { autonomia: autonomiaSel.value } };
    case 'asistencia': return { url: `${base}/asistencia`, datos: { horas: horas.value } };
    case 'reset': return { url: `${base}/resetear-2fa`, datos: { usuarioId: a.usuarioId } };
    case 'invitacion': return { url: `${base}/reenviar-invitacion`, datos: {} };
  }
}
async function confirmar(codigo: string) {
  errModal.value = ''; ocupado.value = true;
  try {
    const { url, datos } = cuerpo();
    const r = await api<{ enviada?: boolean; enlace?: string }>('POST', url, { ...datos, codigo });
    const era = accion.value!.tipo;
    accion.value = null; enlaceDePrueba.value = r.enlace ?? '';
    aviso.value = era === 'invitacion' && r.enviada === false ? 'Generamos la invitación pero no pudimos enviar el correo. Inténtalo de nuevo en unos minutos.' : 'Hecho. Quedó registrado en la bitácora del cliente.';
    await cargar();
  } catch (e) { errModal.value = mensajeError(e); } finally { ocupado.value = false; }
}
const TITULO: Record<Tipo, string> = { saldo: 'Mover saldo', plan: 'Cambiar plan', estado: 'Cambiar estado', modo: 'Cambiar modo de atención', autonomia: 'Cambiar autonomía', asistencia: 'Modo asistencia', reset: 'Restablecer verificación en dos pasos', invitacion: 'Reenviar invitación' };
const ETQ_INV: Record<string, string> = { pendiente: 'Pendiente', vencida: 'Vencida', aceptada: 'Aceptada', revocada: 'Revocada' };
const peligro = computed(() => accion.value?.tipo === 'estado' && estadoSel.value !== 'activo');
const pct = computed(() => f.value && f.value.plan.cuota > 0 ? Math.min(100, Math.round((f.value.consumidoMes / f.value.plan.cuota) * 100)) : 0);
const visible = computed(() => (f.value && f.value.estado !== 'suspendido' && f.value.estado !== 'baja' && f.value.saldo <= 0 ? 'sin_saldo' : f.value?.estado ?? ''));
</script>

<template>
  <router-link to="/administracion">← Volver a clientes</router-link>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>
  <p v-if="enlaceDePrueba" class="aviso alerta">Solo en desarrollo, el correo no sale: <span class="mono" style="word-break:break-all;user-select:all">{{ enlaceDePrueba }}</span></p>
  <template v-if="f">
    <header class="encabezado">
      <div><h1 class="titulo">{{ f.nombre }}</h1><p class="sec" style="font-size:20px;margin-top:6px">Cliente desde el {{ fecha(f.creada) }} · admin: {{ f.equipo.find((u) => u.rol === 'admin')?.email }}</p></div>
      <span class="est" :class="'e-' + visible">{{ ETIQUETA_ESTADO[visible] }}</span>
    </header>

    <section class="card v" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between" aria-label="Modo de atención">
      <div style="max-width:700px"><p class="lbl v">Modo de atención</p><p style="font-weight:800;font-size:26px;margin-top:4px">{{ ETIQUETA_MODO[f.modo] }}</p>
        <p class="sec" style="margin-top:2px">En modo gestionada el cliente ve un aviso permanente y cada acción nuestra queda en su bitácora con el nombre de quien la hizo.</p></div>
      <button v-if="puede('admin', 'soporte')" class="btn2" type="button" @click="abrir('modo')">{{ f.modo === 'gestionada' ? 'Cambiar a autoservicio' : 'Cambiar a gestionada' }}</button>
    </section>

    <section class="rejilla-2">
      <div class="card" style="display:flex;flex-direction:column;gap:8px">
        <p class="lbl">Plan y saldo</p><p style="font-weight:800;font-size:28px">{{ f.plan.nombre }}</p>
        <p>{{ num(f.consumidoMes) }} de {{ num(f.plan.cuota) }} consultas usadas · saldo {{ num(f.saldo) }}</p>
        <div class="barra"><i :style="{ width: pct + '%' }"></i></div>
        <div class="chips" style="margin-top:8px">
          <button v-if="puede('admin', 'finanzas')" class="btn2" type="button" @click="abrir('plan')">Cambiar plan</button>
          <button v-if="puede('admin', 'finanzas')" class="btn2" type="button" @click="abrir('saldo')">Mover saldo</button>
        </div>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:8px">
        <p class="lbl">Conexiones y autonomía</p><p style="font-weight:800;font-size:28px">{{ f.conexiones }} {{ f.conexiones === 1 ? 'conexión' : 'conexiones' }}</p>
        <p>Autonomía: <b>{{ ETIQUETA_AUTONOMIA[f.autonomia] }}</b></p>
        <div style="margin-top:8px"><button v-if="puede('admin', 'soporte')" class="btn2" type="button" @click="abrir('autonomia')">Cambiar autonomía</button></div>
      </div>
    </section>

    <section class="card" style="border:1.5px solid var(--accion)" aria-labelledby="as">
      <h2 id="as" class="sub">Acciones <em>sensibles</em></h2>
      <p class="sec" style="margin-top:4px">Cada una te pide un código nuevo de tu verificación en dos pasos.</p>
      <p v-if="asistenciaVigente" class="aviso alerta" style="margin-top:12px">Modo asistencia activo hasta el {{ fechaHora(f.asistenciaHasta!) }}.</p>
      <div class="chips" style="margin-top:16px">
        <template v-if="puede('admin')">
          <button v-if="f.estado === 'suspendido' || f.estado === 'baja'" class="btn2" type="button" @click="abrir('estado', {}, 'activo')">Reactivar cliente</button>
          <template v-else><button class="btn2" type="button" @click="abrir('estado', {}, 'suspendido')">Suspender cliente</button><button class="btn2" type="button" @click="abrir('estado', {}, 'baja')">Dar de baja</button></template>
        </template>
        <button v-if="puede('admin', 'soporte')" class="btn2" type="button" @click="abrir('asistencia')">{{ asistenciaVigente ? 'Renovar o terminar asistencia' : 'Activar modo asistencia' }}</button>
      </div>
      <p class="sec" style="font-size:16px;margin-top:12px">No existe una opción para entrar como el cliente. Para ayudarle usamos el modo asistencia, que lo avisa y queda registrado.</p>
    </section>

    <FichaConexiones :org-id="id" @cambio="cargar" />
    <FichaUso :org-id="id" />
    <FichaWidget :org-id="id" />

    <section class="card tabla-caja" aria-labelledby="eq">
      <h2 id="eq" class="sub" style="padding:20px 24px 12px">Personas de la <em>cuenta</em></h2>
      <table class="tabla">
        <thead><tr><th>Correo</th><th>Rol</th><th>2 pasos</th><th></th></tr></thead>
        <tbody><tr v-for="u in f.equipo" :key="u.id">
          <td>{{ u.email }}<span v-if="u.nombre" class="sec"> · {{ u.nombre }}</span></td><td>{{ u.rol === 'admin' ? 'Administrador' : 'Miembro' }}</td><td>{{ u.totpActivo ? 'Activa' : 'No' }}</td>
          <td><button v-if="puede('admin', 'soporte') && u.totpActivo" class="btn2" style="min-height:40px;padding:0 16px;font-size:16px" type="button" @click="abrir('reset', { usuarioId: u.id, usuarioEmail: u.email })">Restablecer 2 pasos</button></td>
        </tr></tbody>
      </table>
    </section>

    <section v-if="f.invitaciones.length" class="card tabla-caja" aria-labelledby="iv">
      <h2 id="iv" class="sub" style="padding:20px 24px 12px"><em>Invitaciones</em> de la cuenta</h2>
      <table class="tabla">
        <thead><tr><th>Correo</th><th>Rol</th><th>Vence</th><th>Estado</th></tr></thead>
        <tbody><tr v-for="(i, k) in f.invitaciones" :key="k"><td>{{ i.email }}</td><td>{{ i.rol === 'admin' ? 'Administrador' : 'Miembro' }}</td><td>{{ fecha(i.expira) }}</td><td>{{ ETQ_INV[i.estado] }}</td></tr></tbody>
      </table>
      <div v-if="puede('admin', 'soporte') && f.invitaciones[0] && f.invitaciones[0].estado !== 'aceptada'" style="padding:0 24px 20px"><button class="btn2" type="button" @click="abrir('invitacion')">Reenviar invitación</button></div>
    </section>

    <section class="card tabla-caja" aria-labelledby="bi">
      <h2 id="bi" class="sub" style="padding:20px 24px 12px">Bitácora de operadores <span class="sec" style="font-size:16px;font-weight:500">· el cliente también la ve</span></h2>
      <table class="tabla">
        <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué hizo</th></tr></thead>
        <tbody><tr v-for="(b, i) in f.bitacora" :key="i"><td>{{ fechaHora(b.cuando) }}</td><td>{{ b.quien }}</td><td>{{ b.detalle }}</td></tr>
          <tr v-if="!f.bitacora.length"><td colspan="3" class="sec">Todavía no hay acciones del equipo.</td></tr></tbody>
      </table>
    </section>

    <ModalCodigo v-if="accion" :titulo="TITULO[accion.tipo]" :ocupado="ocupado" :error="errModal" :peligro="peligro" @confirmar="confirmar" @cancelar="accion = null">
      <template v-if="accion.tipo === 'saldo'">
        <div class="form">
          <div class="campo-grupo"><label class="etq" for="st">Tipo</label><select id="st" v-model="saldoTipo" class="campo"><option value="recarga">Recarga (suma)</option><option value="ajuste">Ajuste (suma o resta, con motivo)</option></select></div>
          <div class="campo-grupo"><label class="etq" for="sc">Cantidad de consultas</label><input id="sc" v-model.number="saldoCantidad" class="campo" type="number" step="1" :min="saldoTipo === 'recarga' ? 1 : -100000" max="100000"></div>
          <div class="campo-grupo"><label class="etq" for="sm">Motivo{{ saldoTipo === 'ajuste' ? '' : ' (opcional)' }}</label><input id="sm" v-model="saldoMotivo" class="campo" maxlength="200"><p class="ayuda">El cliente ve este motivo en su bitácora.</p></div>
        </div>
      </template>
      <template v-else-if="accion.tipo === 'plan'">
        <div class="campo-grupo"><label class="etq" for="pp">Plan nuevo</label><select id="pp" v-model="planSel" class="campo"><option v-for="p in PLANES" :key="p.id" :value="p.id">{{ p.nombre }}</option></select>
          <p class="ayuda">Cambiar de plan no repone consultas: si hace falta, mueve saldo aparte.</p></div>
      </template>
      <template v-else-if="accion.tipo === 'estado'"><p><b>{{ estadoSel === 'activo' ? 'Reactivar' : estadoSel === 'baja' ? 'Dar de baja' : 'Suspender' }}</b> la cuenta de {{ f.nombre }}.
        <template v-if="estadoSel !== 'activo'"> Se cerrarán las sesiones abiertas de sus usuarios y no podrán entrar.</template></p></template>
      <template v-else-if="accion.tipo === 'invitacion'"><p>Enviar una invitación nueva al administrador de {{ f.nombre }}. El enlace anterior deja de servir y el nuevo vence en 7 días.</p></template>
      <template v-else-if="accion.tipo === 'modo'"><p>Dejar la cuenta en <b>{{ ETIQUETA_MODO[modoSel] }}</b>.</p></template>
      <template v-else-if="accion.tipo === 'autonomia'">
        <div class="campo-grupo"><label class="etq" for="au">Autonomía</label><select id="au" v-model="autonomiaSel" class="campo"><option v-for="(t, k) in ETIQUETA_AUTONOMIA" :key="k" :value="k">{{ t }}</option></select></div>
      </template>
      <template v-else-if="accion.tipo === 'asistencia'">
        <div class="campo-grupo"><label class="etq" for="ho">Horas de asistencia (0 para terminarla)</label><input id="ho" v-model.number="horas" class="campo" type="number" min="0" max="72" step="1"></div>
      </template>
      <template v-else><p>Restablecer la verificación en dos pasos de <b>{{ accion.usuarioEmail }}</b>. Se cerrarán sus sesiones y tendrá que configurarla de nuevo.
        <template v-if="f.modo !== 'gestionada' && !asistenciaVigente"><br><b>Antes activa el modo asistencia</b> (o deja la cuenta en gestionada): sin eso el sistema lo rechaza.</template></p></template>
    </ModalCodigo>
  </template>
</template>
