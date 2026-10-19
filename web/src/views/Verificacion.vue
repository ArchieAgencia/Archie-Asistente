<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, mensajeError } from '../api';
import CodigoInput from '../componentes/CodigoInput.vue';

const router = useRouter();
const codigo = ref('');
const recuperacion = ref('');
const modoRecuperacion = ref(false);
const error = ref('');
const ocupado = ref(false);

async function verificar() {
  error.value = ''; ocupado.value = true;
  try {
    if (modoRecuperacion.value) {
      await api('POST', '/auth/2fa', { recuperacion: recuperacion.value });
      await router.push('/seguridad'); // tras usar un código de recuperación conviene revisar el segundo factor y generar códigos nuevos
    } else {
      await api('POST', '/auth/2fa', { codigo: codigo.value });
      await router.push('/');
    }
  } catch (e) { error.value = mensajeError(e); codigo.value = ''; recuperacion.value = ''; }
  finally { ocupado.value = false; }
}
function alternar() { modoRecuperacion.value = !modoRecuperacion.value; error.value = ''; codigo.value = ''; recuperacion.value = ''; }
</script>

<template>
  <main class="centrado">
    <form class="tarjeta-entrada" @submit.prevent="verificar">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <template v-if="!modoRecuperacion">
        <div><h2 class="sub">Verificación en <em>dos pasos</em></h2><p class="sec" style="margin-top:4px">Escribe el código de 6 dígitos de tu aplicación de autenticación.</p></div>
        <CodigoInput v-model="codigo" etiqueta="Código de 6 dígitos" autofoco />
      </template>
      <template v-else>
        <div><h2 class="sub">Código de <em>recuperación</em></h2><p class="sec" style="margin-top:4px">Escribe uno de los códigos que guardaste al activar la verificación. Cada uno sirve una sola vez.</p></div>
        <div class="campo-grupo"><label class="etq" for="rec">Código de recuperación</label><input id="rec" v-model="recuperacion" class="campo mono" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="XXXX-XXXX-XXXX-XXXX" required></div>
      </template>
      <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
      <button class="btn" type="submit" :disabled="ocupado || (modoRecuperacion ? recuperacion.trim().length < 8 : codigo.length !== 6)">Verificar</button>
      <p class="sec" style="font-size:16px"><a href="#" @click.prevent="alternar">{{ modoRecuperacion ? 'Usar el código de mi aplicación' : '¿Perdiste tu teléfono? Usa un código de recuperación' }}</a></p>
      <p v-if="!modoRecuperacion" class="sec" style="font-size:16px">¿Tampoco tienes los códigos? Escríbenos y verificamos tu identidad por otro canal antes de restablecerlo.</p>
      <router-link to="/entrar">Volver a entrar</router-link>
    </form>
  </main>
</template>
