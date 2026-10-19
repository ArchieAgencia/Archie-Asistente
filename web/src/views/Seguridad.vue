<script setup lang="ts">
import CampoSecreto from '../componentes/CampoSecreto.vue';
import qrcode from 'qrcode-generator';
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import CodigoInput from '../componentes/CodigoInput.vue';
import CodigosRecuperacion from '../componentes/CodigosRecuperacion.vue';
import { cargarResumen, cargarYo, sesion } from '../store';

const activo = computed(() => sesion.yo?.totpActivo ?? false);
onMounted(() => { cargarYo().catch(() => undefined); });

// Activar el segundo factor
const pass2fa = ref(''); const config = ref<{ secreto: string; uri: string } | null>(null); const codigo = ref('');
const err2fa = ref(''); const ok2fa = ref(''); const ocupado = ref(false);
const svgQr = computed(() => { if (!config.value) return ''; const q = qrcode(0, 'M'); q.addData(config.value.uri); q.make(); return q.createSvgTag({ scalable: true, margin: 2 }); });

async function iniciar() {
  err2fa.value = ''; ocupado.value = true;
  try { config.value = await api('POST', '/auth/2fa/iniciar', { password: pass2fa.value }); pass2fa.value = ''; }
  catch (e) { err2fa.value = mensajeError(e); } finally { ocupado.value = false; }
}
async function confirmar() {
  err2fa.value = ''; ocupado.value = true;
  try {
    const r = await api<{ codigos: string[] }>('POST', '/auth/2fa/confirmar', { codigo: codigo.value });
    codigosNuevos.value = r.codigos;
    config.value = null; codigo.value = ''; ok2fa.value = 'Listo: la verificación en dos pasos está activa.';
    await cargarYo(); await cargarResumen().catch(() => undefined);
  } catch (e) { err2fa.value = mensajeError(e); codigo.value = ''; } finally { ocupado.value = false; }
}

// Códigos de recuperación
const codigosNuevos = ref<string[] | null>(null);
const passCodigos = ref(''); const errCodigos = ref(''); const regenerando = ref(false);
async function regenerar() {
  errCodigos.value = ''; ocupado.value = true;
  try { codigosNuevos.value = (await api<{ codigos: string[] }>('POST', '/auth/2fa/codigos', { password: passCodigos.value })).codigos; passCodigos.value = ''; regenerando.value = false; await cargarYo(); }
  catch (e) { errCodigos.value = mensajeError(e); } finally { ocupado.value = false; }
}
async function guardados() { codigosNuevos.value = null; await cargarYo(); }

// Cambiar la contraseña
const actual = ref(''); const nueva = ref(''); const errPw = ref(''); const okPw = ref('');
async function cambiar() {
  errPw.value = ''; okPw.value = '';
  try { await api('POST', '/auth/password', { actual: actual.value, nueva: nueva.value }); okPw.value = 'Contraseña cambiada. Cerramos tus otras sesiones.'; actual.value = ''; nueva.value = ''; }
  catch (e) { errPw.value = mensajeError(e); }
}
</script>

<template>
  <header class="encabezado"><h1 class="titulo"><em>Seguridad</em> de tu cuenta</h1></header>

  <p v-if="sesion.yo?.rol === 'admin' && !activo" class="aviso alerta" role="status">Como administrador, necesitas activar la verificación en dos pasos para seguir usando Archie AI. Toma un par de minutos.</p>

  <section class="card" aria-labelledby="s2">
    <h2 id="s2" class="sub">Verificación en <em>dos pasos</em></h2>
    <p v-if="ok2fa" class="aviso ok" role="status" style="margin-top:12px">{{ ok2fa }}</p>
    <template v-if="activo && !config">
      <p style="margin-top:8px"><span class="est e-activo">Activa</span> Al entrar te pedimos un código de tu aplicación de autenticación.</p>
    </template>
    <CodigosRecuperacion v-if="codigosNuevos" :codigos="codigosNuevos" @guardados="guardados" />
    <template v-else-if="!config">
      <p class="sec" style="margin-top:8px">Protege tu cuenta con un código que cambia cada 30 segundos (Google Authenticator, Authy, Bitwarden u otra aplicación).</p>
      <form class="form" style="margin-top:16px;max-width:420px" @submit.prevent="iniciar">
        <div class="campo-grupo"><label class="etq" for="p2">Tu contraseña actual</label><CampoSecreto id="p2" v-model="pass2fa" autocomplete="current-password" required /></div>
        <p v-if="err2fa" class="aviso error" role="alert">{{ err2fa }}</p>
        <button class="btn" type="submit" :disabled="ocupado">Empezar</button>
      </form>
    </template>
    <template v-else>
      <ol style="margin:12px 0 0;padding-left:22px;display:flex;flex-direction:column;gap:8px">
        <li>Escanea el código con tu aplicación de autenticación.</li>
        <li>Si no puedes escanear, escribe esta clave: <b class="mono" style="word-break:break-all">{{ config.secreto }}</b></li>
        <li>Escribe el código de 6 dígitos que muestra la aplicación.</li>
      </ol>
      <div v-html="svgQr" style="width:200px;margin:16px 0" aria-label="Código QR para tu aplicación"></div>
      <form class="form" style="max-width:420px" @submit.prevent="confirmar">
        <CodigoInput v-model="codigo" etiqueta="Código de 6 dígitos" />
        <p v-if="err2fa" class="aviso error" role="alert">{{ err2fa }}</p>
        <button class="btn" type="submit" :disabled="ocupado || codigo.length !== 6">Activar</button>
      </form>
    </template>
  </section>

  <section v-if="activo && !config" class="card" aria-labelledby="cr">
    <h2 id="cr" class="sub">Códigos de <em>recuperación</em></h2>
    <p style="margin-top:8px">Si pierdes tu teléfono, estos códigos te dejan entrar. Cada uno sirve una sola vez.</p>
    <p v-if="(sesion.yo?.codigosRestantes ?? 0) === 0" class="aviso alerta" role="alert" style="margin-top:10px">No tienes códigos disponibles. Genera un juego nuevo.</p>
    <p v-else-if="(sesion.yo?.codigosRestantes ?? 0) <= 3" class="aviso alerta" role="status" style="margin-top:10px">Te quedan pocos códigos. Genera un juego nuevo cuando puedas.</p>
    <p v-else class="sec" style="margin-top:10px">Te quedan <b>{{ sesion.yo?.codigosRestantes }}</b> códigos.</p>
    <button v-if="!regenerando" class="btn2" type="button" style="margin-top:12px" @click="regenerando = true">Generar un juego nuevo</button>
    <form v-else class="form" style="margin-top:14px;max-width:420px" @submit.prevent="regenerar">
      <p class="sec">Al generar uno nuevo, los códigos anteriores dejan de servir.</p>
      <div class="campo-grupo"><label class="etq" for="pc">Tu contraseña actual</label><CampoSecreto id="pc" v-model="passCodigos" autocomplete="current-password" required /></div>
      <p v-if="errCodigos" class="aviso error" role="alert">{{ errCodigos }}</p>
      <button class="btn" type="submit" :disabled="ocupado">Generar</button>
    </form>
  </section>

  <section class="card" aria-labelledby="pw">
    <h2 id="pw" class="sub">Cambiar la <em>contraseña</em></h2>
    <form class="form" style="margin-top:14px;max-width:420px" @submit.prevent="cambiar">
      <div class="campo-grupo"><label class="etq" for="pa">Contraseña actual</label><CampoSecreto id="pa" v-model="actual" autocomplete="current-password" required /></div>
      <div class="campo-grupo"><label class="etq" for="pn">Contraseña nueva</label><CampoSecreto id="pn" v-model="nueva" autocomplete="new-password" minlength="12" required /><p class="ayuda">Mínimo 12 caracteres. Una frase larga funciona muy bien.</p></div>
      <p v-if="errPw" class="aviso error" role="alert">{{ errPw }}</p>
      <p v-if="okPw" class="aviso ok" role="status">{{ okPw }}</p>
      <button class="btn" type="submit">Cambiar contraseña</button>
    </form>
  </section>
</template>
