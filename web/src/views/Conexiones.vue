<script setup lang="ts">
import CampoSecreto from '../componentes/CampoSecreto.vue';
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import { fechaHora } from '../format';
import { sesion } from '../store';

interface Estado { disponible: boolean; conectado: boolean; probadaEn: string | null; pruebaOk: boolean | null }
const e = ref<Estado | null>(null);
const usuario = ref(''); const token = ref('');
const error = ref(''); const aviso = ref(''); const ocupado = ref(false); const confirmarQuitar = ref(false);
const esAdmin = computed(() => sesion.yo?.rol === 'admin');

async function cargar() { try { e.value = await api<Estado>('GET', '/api/panel/conexiones'); } catch (x) { error.value = mensajeError(x); } }
onMounted(cargar);

async function conectar() {
  error.value = ''; aviso.value = ''; ocupado.value = true;
  try {
    await api('POST', '/api/panel/conexiones/send', { usuario: usuario.value.trim(), token: token.value });
    aviso.value = 'Listo: Archie AI ya puede consultar tu Archie Send. Guardamos la clave cifrada y no la volveremos a mostrar.';
    token.value = ''; usuario.value = '';
    await cargar();
  } catch (x) { error.value = mensajeError(x); } finally { ocupado.value = false; }
}

// ---------- Tiendas en línea (WooCommerce, Shopify, VTEX) ----------
type Plat = 'woocommerce' | 'shopify' | 'vtex';
interface Tienda { nombre: string; plataforma: Plat; origen: string | null; probadaEn: string | null; pruebaOk: boolean | null }
const NOMBRE_PLAT: Record<Plat, string> = { woocommerce: 'WooCommerce', shopify: 'Shopify', vtex: 'VTEX' };
const tiendas = ref<Tienda[]>([]);
const plat = ref<Plat>('woocommerce');
const tNombre = ref(''); const tDominio = ref(''); const tClave = ref(''); const tSecreto = ref('');
const tTienda = ref(''); const tToken = ref(''); const tCuenta = ref(''); const tAppKey = ref(''); const tAppToken = ref('');
const tError = ref(''); const tAviso = ref(''); const tOcupado = ref(false); const quitando = ref('');

async function cargarTiendas() { try { tiendas.value = (await api<{ tiendas: Tienda[] }>('GET', '/api/panel/tiendas')).tiendas; } catch (x) { tError.value = mensajeError(x); } }
onMounted(cargarTiendas);

function cuerpoTienda(): object {
  const nombre = tNombre.value.trim();
  if (plat.value === 'woocommerce') return { plataforma: 'woocommerce', nombre, dominio: tDominio.value.trim(), clave: tClave.value.trim(), secreto: tSecreto.value.trim() };
  if (plat.value === 'shopify') return { plataforma: 'shopify', nombre, tienda: tTienda.value.trim(), token: tToken.value.trim() };
  return { plataforma: 'vtex', nombre, cuenta: tCuenta.value.trim(), appKey: tAppKey.value.trim(), appToken: tAppToken.value.trim() };
}
async function conectarTienda() {
  tError.value = ''; tAviso.value = ''; tOcupado.value = true;
  try {
    await api('POST', '/api/panel/tiendas', cuerpoTienda());
    tAviso.value = `Listo: Archie AI ya puede consultar «${tNombre.value.trim()}» (solo lectura). Guardamos las credenciales cifradas y no las volveremos a mostrar.`;
    for (const r of [tNombre, tDominio, tClave, tSecreto, tTienda, tToken, tCuenta, tAppKey, tAppToken]) r.value = '';
    await cargarTiendas();
  } catch (x) { tError.value = mensajeError(x); } finally { tOcupado.value = false; }
}
async function quitarTienda(nombre: string) {
  if (quitando.value !== nombre) { quitando.value = nombre; return; }
  tError.value = ''; tAviso.value = ''; tOcupado.value = true;
  try { await api('POST', '/api/panel/tiendas/quitar', { nombre }); tAviso.value = `Desconectamos «${nombre}» y borramos sus credenciales guardadas.`; await cargarTiendas(); }
  catch (x) { tError.value = mensajeError(x); } finally { tOcupado.value = false; quitando.value = ''; }
}

// ---------- Pauta digital (Meta Ads, TikTok Ads) ----------
type PlatP = 'meta' | 'tiktok';
interface CuentaPauta { nombre: string; plataforma: PlatP; origen: string | null; probadaEn: string | null; pruebaOk: boolean | null }
const NOMBRE_PAUTA: Record<PlatP, string> = { meta: 'Meta Ads', tiktok: 'TikTok Ads' };
const cuentasPauta = ref<CuentaPauta[]>([]);
const platP = ref<PlatP>('meta');
const pNombre = ref(''); const pCuenta = ref(''); const pToken = ref('');
const pError = ref(''); const pAviso = ref(''); const pOcupado = ref(false); const quitandoP = ref('');

async function cargarPauta() { try { cuentasPauta.value = (await api<{ cuentas: CuentaPauta[] }>('GET', '/api/panel/pauta')).cuentas; } catch (x) { pError.value = mensajeError(x); } }
onMounted(cargarPauta);

async function conectarPauta() {
  pError.value = ''; pAviso.value = ''; pOcupado.value = true;
  const nombre = pNombre.value.trim();
  try {
    await api('POST', '/api/panel/pauta', platP.value === 'meta'
      ? { plataforma: 'meta', nombre, cuenta: pCuenta.value.trim(), token: pToken.value.trim() }
      : { plataforma: 'tiktok', nombre, anunciante: pCuenta.value.trim(), token: pToken.value.trim() });
    pAviso.value = `Listo: Archie AI ya puede consultar la pauta de «${nombre}» (solo lectura, solo métricas). Guardamos el token cifrado y no lo volveremos a mostrar.`;
    pNombre.value = ''; pCuenta.value = ''; pToken.value = '';
    await cargarPauta();
  } catch (x) { pError.value = mensajeError(x); } finally { pOcupado.value = false; }
}
async function quitarPauta(nombre: string) {
  if (quitandoP.value !== nombre) { quitandoP.value = nombre; return; }
  pError.value = ''; pAviso.value = ''; pOcupado.value = true;
  try { await api('POST', '/api/panel/pauta/quitar', { nombre }); pAviso.value = `Desconectamos «${nombre}» y borramos su token guardado.`; await cargarPauta(); }
  catch (x) { pError.value = mensajeError(x); } finally { pOcupado.value = false; quitandoP.value = ''; }
}

// ---------- Suite Archie (Talk, Meet, Booking) ----------
type ProdS = 'talk' | 'meet' | 'booking';
interface ConexionSuite { producto: ProdS; dominio: string | null; probadaEn: string | null; pruebaOk: boolean | null }
const NOMBRE_SUITE: Record<ProdS, string> = { talk: 'Archie Talk', meet: 'Archie Meet', booking: 'Archie Booking' };
const conexionesSuite = ref<ConexionSuite[]>([]);
const prodS = ref<ProdS>('talk');
const sDominio = ref(''); const sClave = ref('');
const sError = ref(''); const sAviso = ref(''); const sOcupado = ref(false); const quitandoS = ref<ProdS | ''>('');

async function cargarSuite() { try { conexionesSuite.value = (await api<{ conexiones: ConexionSuite[] }>('GET', '/api/panel/suite')).conexiones; } catch (x) { sError.value = mensajeError(x); } }
onMounted(cargarSuite);

async function conectarSuite() {
  sError.value = ''; sAviso.value = ''; sOcupado.value = true;
  const nombre = NOMBRE_SUITE[prodS.value];
  try {
    await api('POST', '/api/panel/suite', { producto: prodS.value, dominio: sDominio.value.trim(), clave: sClave.value.trim() });
    sAviso.value = `Listo: Archie AI ya puede consultar ${nombre} (solo lectura, sin datos de personas). Guardamos la clave cifrada y no la volveremos a mostrar.`;
    sDominio.value = ''; sClave.value = '';
    await cargarSuite();
  } catch (x) { sError.value = mensajeError(x); } finally { sOcupado.value = false; }
}
async function quitarSuite(p: ProdS) {
  if (quitandoS.value !== p) { quitandoS.value = p; return; }
  sError.value = ''; sAviso.value = ''; sOcupado.value = true;
  try { await api('POST', '/api/panel/suite/quitar', { producto: p }); sAviso.value = `Desconectamos ${NOMBRE_SUITE[p]} y borramos su clave guardada.`; await cargarSuite(); }
  catch (x) { sError.value = mensajeError(x); } finally { sOcupado.value = false; quitandoS.value = ''; }
}

async function quitar() {
  if (!confirmarQuitar.value) { confirmarQuitar.value = true; return; }
  error.value = ''; aviso.value = ''; ocupado.value = true;
  try { await api('POST', '/api/panel/conexiones/send/quitar', {}); aviso.value = 'Desconectamos Archie Send y borramos la clave guardada.'; await cargar(); }
  catch (x) { error.value = mensajeError(x); } finally { ocupado.value = false; confirmarQuitar.value = false; }
}
</script>

<template>
  <header class="encabezado"><h1 class="titulo">Cone<em>xiones</em></h1></header>
  <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
  <p v-if="aviso" class="aviso ok" role="status">{{ aviso }}</p>

  <section class="card" aria-labelledby="send">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
      <h2 id="send" class="sub">Archie <em>Send</em></h2>
      <span v-if="e" class="chip" :class="{ on: e.conectado && e.pruebaOk }" style="cursor:default" role="status">
        {{ !e.conectado ? 'No conectado' : e.pruebaOk === false ? 'La clave dejó de funcionar' : 'Conectado' }}
      </span>
    </div>
    <p class="sec" style="margin-top:8px">Con esta conexión, Archie AI puede <b>consultar</b> tus listas, campañas, segmentos, créditos y errores de envío. En esta versión no envía, crea ni cambia nada.</p>
    <p v-if="e?.probadaEn" class="sec" style="margin-top:6px;font-size:16px">Última comprobación: {{ fechaHora(e.probadaEn) }}</p>
    <p v-if="e && !e.disponible" class="aviso alerta" style="margin-top:12px">La conexión con Archie Send aún no está habilitada en este servidor. Escríbenos y la activamos.</p>

    <template v-if="e?.disponible">
      <p v-if="!esAdmin" class="aviso info" style="margin-top:12px">Solo un administrador de tu cuenta puede conectar o desconectar herramientas.</p>
      <form v-else class="form" style="max-width:560px;margin-top:16px" @submit.prevent="conectar">
        <h3 style="font-weight:800;font-size:20px">{{ e.conectado ? 'Cambiar la clave' : 'Conectar con una clave de API' }}</h3>
        <div class="campo-grupo"><label class="etq" for="cu">Usuario de la API</label><input id="cu" v-model="usuario" class="campo" required maxlength="100" autocomplete="off" spellcheck="false"></div>
        <div class="campo-grupo"><label class="etq" for="ct">Clave de la API</label><CampoSecreto id="ct" v-model="token" required maxlength="200" autocomplete="off" spellcheck="false" />
          <p class="ayuda">La probamos antes de guardarla. Se guarda cifrada y no vuelve a mostrarse en pantalla.</p></div>
        <button class="btn" type="submit" :disabled="ocupado">{{ ocupado ? 'Comprobando…' : e.conectado ? 'Probar y reemplazar' : 'Probar y conectar' }}</button>
      </form>

      <div v-if="esAdmin" class="aviso info" style="margin-top:20px">
        <p style="font-weight:700">Cómo crear la clave en Archie Send (recomendado)</p>
        <ol style="margin:8px 0 0 22px;line-height:1.5">
          <li>En Archie Send entra a <b>Usuarios</b> y crea un usuario de tipo <b>API</b> dedicado para Archie AI.</li>
          <li>Dale un rol que solo pueda <b>leer</b>: campañas, listas, contactos, envío y rebotes.</li>
          <li>Ponle fecha de vencimiento y un límite bajo de peticiones por minuto.</li>
          <li>Copia el usuario y la clave que te muestra Archie Send (solo la muestra una vez) y pégalos aquí.</li>
        </ol>
      </div>

      <div v-if="esAdmin && e.conectado" style="margin-top:20px">
        <button class="btn2" type="button" :disabled="ocupado" @click="quitar">{{ confirmarQuitar ? 'Sí, desconectar y borrar la clave' : 'Desconectar' }}</button>
        <button v-if="confirmarQuitar" class="btn2" type="button" style="margin-left:8px" @click="confirmarQuitar = false">Cancelar</button>
      </div>
    </template>
  </section>

  <section class="card" style="margin-top:20px" aria-labelledby="tiendas">
    <h2 id="tiendas" class="sub">Tiendas <em>en línea</em></h2>
    <p class="sec" style="margin-top:8px">Conecta tus tiendas WooCommerce, Shopify o VTEX. Archie AI puede <b>consultar</b> ventas, pedidos, productos, stock y cupones. <b>No cambia nada</b> en la tienda y <b>no ve datos personales de tus compradores</b> (ni nombres, ni correos, ni teléfonos, ni direcciones).</p>
    <p v-if="tError" class="aviso error" role="alert" style="margin-top:12px">{{ tError }}</p>
    <p v-if="tAviso" class="aviso ok" role="status" style="margin-top:12px">{{ tAviso }}</p>

    <ul v-if="tiendas.length" style="list-style:none;padding:0;margin-top:16px;display:grid;gap:10px">
      <li v-for="t in tiendas" :key="t.nombre" class="card" style="padding:14px 16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
        <div>
          <p style="font-weight:800;font-size:20px">{{ t.nombre }}</p>
          <p class="sec" style="font-size:16px">{{ NOMBRE_PLAT[t.plataforma] }} · {{ t.origen }}<template v-if="t.probadaEn"> · comprobada {{ fechaHora(t.probadaEn) }}</template></p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="chip" :class="{ on: t.pruebaOk }" style="cursor:default" role="status">{{ t.pruebaOk === false ? 'Las credenciales dejaron de funcionar' : 'Conectada' }}</span>
          <template v-if="esAdmin">
            <button class="btn2" type="button" :disabled="tOcupado" @click="quitarTienda(t.nombre)">{{ quitando === t.nombre ? 'Sí, desconectar y borrar' : 'Desconectar' }}</button>
            <button v-if="quitando === t.nombre" class="btn2" type="button" @click="quitando = ''">Cancelar</button>
          </template>
        </div>
      </li>
    </ul>
    <p v-else class="sec" style="margin-top:12px">Todavía no hay tiendas conectadas.</p>

    <p v-if="!esAdmin" class="aviso info" style="margin-top:12px">Solo un administrador de tu cuenta puede conectar o desconectar tiendas.</p>
    <template v-else>
      <form class="form" style="max-width:560px;margin-top:16px" @submit.prevent="conectarTienda">
        <h3 style="font-weight:800;font-size:20px">Conectar una tienda</h3>
        <div class="campo-grupo"><label class="etq" for="tp">Plataforma</label>
          <select id="tp" v-model="plat" class="campo"><option value="woocommerce">WooCommerce</option><option value="shopify">Shopify</option><option value="vtex">VTEX</option></select></div>
        <div class="campo-grupo"><label class="etq" for="tn">Nombre de la tienda</label><input id="tn" v-model="tNombre" class="campo" required maxlength="60" autocomplete="off">
          <p class="ayuda">Con este nombre le pides cosas a Archie AI («¿cómo va la tienda Zapatos?»). Debe ser distinto en cada tienda.</p></div>

        <template v-if="plat === 'woocommerce'">
          <div class="campo-grupo"><label class="etq" for="td">Dirección del sitio</label><input id="td" v-model="tDominio" class="campo" required maxlength="300" placeholder="mitienda.com" autocomplete="off" spellcheck="false">
            <p class="ayuda">Solo el dominio, con https. No se aceptan direcciones con puerto, ni IP.</p></div>
          <div class="campo-grupo"><label class="etq" for="tc">Clave de consumidor</label><input id="tc" v-model="tClave" class="campo" required maxlength="200" placeholder="ck_…" autocomplete="off" spellcheck="false"></div>
          <div class="campo-grupo"><label class="etq" for="ts">Secreto de consumidor</label><CampoSecreto id="ts" v-model="tSecreto" required maxlength="200" placeholder="cs_…" autocomplete="off" spellcheck="false" /></div>
        </template>
        <template v-else-if="plat === 'shopify'">
          <div class="campo-grupo"><label class="etq" for="tt">Dirección de la tienda en Shopify</label><input id="tt" v-model="tTienda" class="campo" required maxlength="300" placeholder="mi-tienda.myshopify.com" autocomplete="off" spellcheck="false"></div>
          <div class="campo-grupo"><label class="etq" for="tk">Token de acceso de la API</label><CampoSecreto id="tk" v-model="tToken" required maxlength="300" autocomplete="off" spellcheck="false" />
            <p class="ayuda">Con permisos de lectura (pedidos, productos e inventario). Shopify solo entrega los pedidos de los últimos 60 días, salvo que la app tenga el permiso especial de todos los pedidos.</p></div>
        </template>
        <template v-else>
          <div class="campo-grupo"><label class="etq" for="vc">Cuenta de VTEX</label><input id="vc" v-model="tCuenta" class="campo" required maxlength="300" placeholder="micuenta" autocomplete="off" spellcheck="false"></div>
          <div class="campo-grupo"><label class="etq" for="vk">App Key</label><input id="vk" v-model="tAppKey" class="campo" required maxlength="200" autocomplete="off" spellcheck="false"></div>
          <div class="campo-grupo"><label class="etq" for="vt">App Token</label><CampoSecreto id="vt" v-model="tAppToken" required maxlength="400" autocomplete="off" spellcheck="false" />
            <p class="ayuda">Crea la llave con un rol que solo pueda leer pedidos y catálogo. En VTEX, las consultas de stock bajo, más vendidos y cupones aún no están disponibles.</p></div>
        </template>
        <p class="ayuda">Probamos las credenciales antes de guardarlas. Se guardan cifradas y no vuelven a mostrarse en pantalla.</p>
        <button class="btn" type="submit" :disabled="tOcupado">{{ tOcupado ? 'Comprobando…' : 'Probar y conectar' }}</button>
      </form>
      <div class="aviso info" style="margin-top:20px">
        <p style="font-weight:700">Recomendación de seguridad</p>
        <p style="margin-top:6px;line-height:1.5">Crea en cada tienda un usuario o llave <b>solo para Archie AI</b>, con el menor permiso posible (solo lectura). Así, aunque esas credenciales se filtraran, no podrían cambiar nada en tu tienda. Encuentras la guía paso a paso de cada plataforma en el centro de ayuda.</p>
      </div>
    </template>
  </section>
  <section class="card" style="margin-top:20px" aria-labelledby="pauta">
    <h2 id="pauta" class="sub">Pauta <em>digital</em></h2>
    <p class="sec" style="margin-top:8px">Conecta tus cuentas de Meta Ads o TikTok Ads. Archie AI puede <b>consultar</b> gasto, alcance, clics y resultados de tus campañas, y compararlos entre periodos. <b>No crea ni cambia anuncios</b>, no toca presupuestos y <b>no ve datos de tu audiencia ni de personas</b>: solo métricas agregadas.</p>
    <p v-if="pError" class="aviso error" role="alert" style="margin-top:12px">{{ pError }}</p>
    <p v-if="pAviso" class="aviso ok" role="status" style="margin-top:12px">{{ pAviso }}</p>

    <ul v-if="cuentasPauta.length" style="list-style:none;padding:0;margin-top:16px;display:grid;gap:10px">
      <li v-for="t in cuentasPauta" :key="t.nombre" class="card" style="padding:14px 16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
        <div>
          <p style="font-weight:800;font-size:20px">{{ t.nombre }}</p>
          <p class="sec" style="font-size:16px">{{ NOMBRE_PAUTA[t.plataforma] }} · {{ t.origen }}<template v-if="t.probadaEn"> · comprobada {{ fechaHora(t.probadaEn) }}</template></p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="chip" :class="{ on: t.pruebaOk }" style="cursor:default" role="status">{{ t.pruebaOk === false ? 'El token dejó de funcionar' : 'Conectada' }}</span>
          <template v-if="esAdmin">
            <button class="btn2" type="button" :disabled="pOcupado" @click="quitarPauta(t.nombre)">{{ quitandoP === t.nombre ? 'Sí, desconectar y borrar' : 'Desconectar' }}</button>
            <button v-if="quitandoP === t.nombre" class="btn2" type="button" @click="quitandoP = ''">Cancelar</button>
          </template>
        </div>
      </li>
    </ul>
    <p v-else class="sec" style="margin-top:12px">Todavía no hay cuentas de pauta conectadas.</p>

    <p v-if="!esAdmin" class="aviso info" style="margin-top:12px">Solo un administrador de tu cuenta puede conectar o desconectar cuentas de pauta.</p>
    <template v-else>
      <form class="form" style="max-width:560px;margin-top:16px" @submit.prevent="conectarPauta">
        <h3 style="font-weight:800;font-size:20px">Conectar una cuenta publicitaria</h3>
        <div class="campo-grupo"><label class="etq" for="pp">Plataforma</label>
          <select id="pp" v-model="platP" class="campo"><option value="meta">Meta Ads (Facebook e Instagram)</option><option value="tiktok">TikTok Ads</option></select></div>
        <div class="campo-grupo"><label class="etq" for="pn">Nombre de la cuenta</label><input id="pn" v-model="pNombre" class="campo" required maxlength="60" autocomplete="off">
          <p class="ayuda">Con este nombre le pides cosas a Archie AI («¿cómo va la pauta de Casa Trenza?»). Debe ser distinto en cada cuenta.</p></div>
        <div class="campo-grupo"><label class="etq" for="pc">{{ platP === 'meta' ? 'Número de la cuenta publicitaria' : 'ID del anunciante' }}</label>
          <input id="pc" v-model="pCuenta" class="campo" required maxlength="60" :placeholder="platP === 'meta' ? 'act_123456789' : '7123456789012345678'" autocomplete="off" spellcheck="false">
          <p v-if="platP === 'meta'" class="ayuda">Lo ves en el Administrador de anuncios. Puedes escribirlo con o sin «act_».</p></div>
        <div class="campo-grupo"><label class="etq" for="pt">Token de acceso</label><CampoSecreto id="pt" v-model="pToken" required maxlength="600" autocomplete="off" spellcheck="false" />
          <p class="ayuda">{{ platP === 'meta' ? 'Token de un usuario del sistema con permiso solo de lectura de anuncios (ads_read).' : 'Token de acceso de la API de TikTok con permiso de solo lectura de reportes.' }}</p></div>
        <p class="ayuda">Probamos el token antes de guardarlo. Se guarda cifrado y no vuelve a mostrarse en pantalla.</p>
        <button class="btn" type="submit" :disabled="pOcupado">{{ pOcupado ? 'Comprobando…' : 'Probar y conectar' }}</button>
      </form>
      <div class="aviso info" style="margin-top:20px">
        <p style="font-weight:700">Recomendación de seguridad</p>
        <p style="margin-top:6px;line-height:1.5">Crea un token <b>solo para Archie AI</b> con el menor permiso posible (solo lectura). Así, aunque se filtrara, no podría crear ni cambiar anuncios ni gastar presupuesto. Las cifras pueden cambiar unas horas por la atribución de cada plataforma, y las fechas se leen en la zona horaria de la cuenta.</p>
      </div>
    </template>
  </section>
  <section class="card" style="margin-top:20px" aria-labelledby="suite">
    <h2 id="suite" class="sub">Suite <em>Archie</em></h2>
    <p class="sec" style="margin-top:8px">Conecta Archie Talk, Archie Meet o Archie Booking. Archie AI puede <b>consultar</b> la atención y el embudo (Talk), tus reuniones (Meet) y tus citas y espacios libres (Booking). <b>No responde, no reserva ni cambia nada</b> y <b>no ve mensajes ni datos de las personas</b>: solo cifras y datos de gestión.</p>
    <p v-if="sError" class="aviso error" role="alert" style="margin-top:12px">{{ sError }}</p>
    <p v-if="sAviso" class="aviso ok" role="status" style="margin-top:12px">{{ sAviso }}</p>

    <ul v-if="conexionesSuite.length" style="list-style:none;padding:0;margin-top:16px;display:grid;gap:10px">
      <li v-for="t in conexionesSuite" :key="t.producto" class="card" style="padding:14px 16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
        <div>
          <p style="font-weight:800;font-size:20px">{{ NOMBRE_SUITE[t.producto] }}</p>
          <p class="sec" style="font-size:16px">{{ t.dominio }}<template v-if="t.probadaEn"> · comprobada {{ fechaHora(t.probadaEn) }}</template></p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="chip" :class="{ on: t.pruebaOk }" style="cursor:default" role="status">{{ t.pruebaOk === false ? 'La clave dejó de funcionar' : 'Conectada' }}</span>
          <template v-if="esAdmin">
            <button class="btn2" type="button" :disabled="sOcupado" @click="quitarSuite(t.producto)">{{ quitandoS === t.producto ? 'Sí, desconectar y borrar' : 'Desconectar' }}</button>
            <button v-if="quitandoS === t.producto" class="btn2" type="button" @click="quitandoS = ''">Cancelar</button>
          </template>
        </div>
      </li>
    </ul>
    <p v-else class="sec" style="margin-top:12px">Todavía no hay herramientas de la suite conectadas.</p>

    <p v-if="!esAdmin" class="aviso info" style="margin-top:12px">Solo un administrador de tu cuenta puede conectar o desconectar herramientas de la suite.</p>
    <template v-else>
      <form class="form" style="max-width:560px;margin-top:16px" @submit.prevent="conectarSuite">
        <h3 style="font-weight:800;font-size:20px">Conectar una herramienta</h3>
        <div class="campo-grupo"><label class="etq" for="sp">Herramienta</label>
          <select id="sp" v-model="prodS" class="campo"><option value="talk">Archie Talk (atención y CRM)</option><option value="meet">Archie Meet (reuniones)</option><option value="booking">Archie Booking (citas)</option></select></div>
        <div class="campo-grupo"><label class="etq" for="sd">Dirección de tu herramienta</label>
          <input id="sd" v-model="sDominio" class="campo" required maxlength="253" placeholder="talk.tuempresa.com" autocomplete="off" spellcheck="false" inputmode="url">
          <p class="ayuda">Solo el dominio, sin rutas ni puertos. Debe ser una dirección pública con https.</p></div>
        <div class="campo-grupo"><label class="etq" for="sk">Clave de acceso</label><CampoSecreto id="sk" v-model="sClave" required maxlength="300" autocomplete="off" spellcheck="false" />
          <p class="ayuda">Clave de la herramienta creada solo para Archie AI, con permiso de solo lectura.</p></div>
        <p class="ayuda">Probamos la clave antes de guardarla. Se guarda cifrada y no vuelve a mostrarse en pantalla.</p>
        <button class="btn" type="submit" :disabled="sOcupado">{{ sOcupado ? 'Comprobando…' : 'Probar y conectar' }}</button>
      </form>
      <div class="aviso info" style="margin-top:20px">
        <p style="font-weight:700">Recomendación de seguridad</p>
        <p style="margin-top:6px;line-height:1.5">Crea una clave <b>solo para Archie AI</b> con el menor permiso posible (solo lectura). Así, aunque se filtrara, no podría responder conversaciones, reservar ni cambiar datos.</p>
      </div>
    </template>
  </section>
</template>
