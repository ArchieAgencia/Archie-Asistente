<script setup lang="ts">
import qrcode from 'qrcode-generator';
import { computed, onMounted, ref } from 'vue';
import { api, mensajeError } from '../api';
import CampoSecreto from '../componentes/CampoSecreto.vue';
import CodigoInput from '../componentes/CodigoInput.vue';
import { ETIQUETA_ROL_OP } from '../format';

// El enlace llega con el token en el fragmento (#t=...): no viaja al servidor. Se lee una vez y se borra de la barra de direcciones.
let token = '';
const estado = ref<'cargando' | 'clave' | 'codigo' | 'listo' | 'invalida'>('cargando');
const vista = ref<{ nombre: string; email: string; rol: string } | null>(null);
const password = ref(''); const repetir = ref(''); const codigo = ref('');
const config = ref<{ secretoTotp: string; uri: string } | null>(null);
const error = ref(''); const ocupado = ref(false);
const svgQr = computed(() => { if (!config.value) return ''; const q = qrcode(0, 'M'); q.addData(config.value.uri); q.make(); return q.createSvgTag({ scalable: true, margin: 2 }); });

onMounted(async () => {
  token = new URLSearchParams(location.hash.slice(1)).get('t') ?? '';
  history.replaceState(null, '', location.pathname);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) { estado.value = 'invalida'; return; }
  try { vista.value = await api('POST', '/api/consola/activacion/ver', { token }); estado.value = 'clave'; } catch { estado.value = 'invalida'; }
});

async function elegirClave() {
  error.value = '';
  if (password.value.length < 12) { error.value = 'La contraseña debe tener al menos 12 caracteres.'; return; }
  if (password.value !== repetir.value) { error.value = 'Las dos contraseñas no coinciden.'; return; }
  ocupado.value = true;
  try { config.value = await api('POST', '/api/consola/activacion/iniciar', { token, password: password.value }); password.value = ''; repetir.value = ''; estado.value = 'codigo'; }
  catch (e) { error.value = mensajeError(e); } finally { ocupado.value = false; }
}
async function confirmar() {
  error.value = ''; ocupado.value = true;
  try { await api('POST', '/api/consola/activacion/completar', { token, codigo: codigo.value }); token = ''; config.value = null; estado.value = 'listo'; }
  catch (e) { error.value = mensajeError(e); codigo.value = ''; } finally { ocupado.value = false; }
}
</script>

<template>
  <main class="centrado" style="background:var(--navy)">
    <section class="tarjeta-entrada">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <p v-if="estado === 'cargando'" class="sec" role="status">Revisando tu invitación…</p>

      <template v-else-if="estado === 'invalida'">
        <h2 class="sub">Esta invitación <em>no sirve</em></h2>
        <p class="aviso alerta" role="alert">El enlace no es válido, ya se usó o venció. Pide a quien te invitó que te envíe uno nuevo.</p>
        <router-link to="/equipo-archie" style="font-size:16px">Ya tengo cuenta: entrar</router-link>
      </template>

      <template v-else-if="estado === 'clave' && vista">
        <div><p class="lbl v">Equipo de Archie · {{ ETIQUETA_ROL_OP[vista.rol] }}</p><h2 class="sub" style="margin-top:4px">Hola, <em>{{ vista.nombre }}</em></h2></div>
        <p class="sec">Vas a activar tu cuenta <b>{{ vista.email }}</b>. Elige tu contraseña; en el siguiente paso activas tu segundo factor.</p>
        <form class="form" @submit.prevent="elegirClave">
          <div class="campo-grupo"><label class="etq" for="p1">Contraseña (mínimo 12 caracteres)</label><CampoSecreto id="p1" v-model="password" autocomplete="new-password" required /></div>
          <div class="campo-grupo"><label class="etq" for="p2">Repite la contraseña</label><CampoSecreto id="p2" v-model="repetir" autocomplete="new-password" required /></div>
          <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
          <button class="btn" type="submit" :disabled="ocupado">Continuar</button>
        </form>
      </template>

      <template v-else-if="estado === 'codigo' && config">
        <h2 class="sub">Activa tu <em>segundo factor</em></h2>
        <ol style="margin:0;padding-left:22px;display:flex;flex-direction:column;gap:8px">
          <li>Abre tu aplicación de autenticación y escanea este código.</li>
          <li>Si no puedes escanear, escribe esta clave: <b class="mono" style="word-break:break-all">{{ config.secretoTotp }}</b></li>
          <li>Escribe el código de 6 dígitos que muestra la aplicación.</li>
        </ol>
        <div v-html="svgQr" style="width:200px;max-width:100%;margin:0 auto;background:#fff;border-radius:12px" aria-label="Código QR para tu aplicación de autenticación" role="img"></div>
        <form class="form" @submit.prevent="confirmar">
          <CodigoInput v-model="codigo" etiqueta="Código de 6 dígitos de tu aplicación" autofoco />
          <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
          <button class="btn" type="submit" :disabled="ocupado || codigo.length !== 6">Activar mi cuenta</button>
        </form>
      </template>

      <template v-else-if="estado === 'listo'">
        <h2 class="sub">Tu cuenta del equipo está <em>lista</em></h2>
        <p class="aviso ok" role="status">Ya puedes entrar con tu correo, tu contraseña y el código de tu aplicación.</p>
        <router-link class="btn" to="/equipo-archie">Entrar</router-link>
      </template>
    </section>
  </main>
</template>
