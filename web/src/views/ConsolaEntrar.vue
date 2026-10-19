<script setup lang="ts">
import CampoSecreto from '../componentes/CampoSecreto.vue';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, mensajeError } from '../api';
import CodigoInput from '../componentes/CodigoInput.vue';

const router = useRouter();
const paso = ref<'clave' | 'codigo'>('clave');
const email = ref(''); const password = ref(''); const codigo = ref('');
const error = ref(''); const ocupado = ref(false);

async function clave() {
  error.value = ''; ocupado.value = true;
  try { await api('POST', '/api/consola/auth/login', { email: email.value, password: password.value }); password.value = ''; paso.value = 'codigo'; }
  catch (e) { error.value = mensajeError(e); password.value = ''; } finally { ocupado.value = false; }
}
async function verificar() {
  error.value = ''; ocupado.value = true;
  try { await api('POST', '/api/consola/auth/2fa', { codigo: codigo.value }); await router.push('/administracion'); }
  catch (e) { error.value = mensajeError(e); codigo.value = ''; } finally { ocupado.value = false; }
}
</script>

<template>
  <main class="centrado" style="background:var(--navy)">
    <form class="tarjeta-entrada" @submit.prevent="paso === 'clave' ? clave() : verificar()">
      <h1 style="margin:0"><img src="/img/logo-claro.svg" alt="Archie AI, by Archie Tech" width="190" height="47" style="display:block"></h1>
      <div><p class="lbl v">Administración</p><h2 class="sub" style="margin-top:4px">Acceso del <em>equipo</em></h2></div>
      <template v-if="paso === 'clave'">
        <div class="form">
          <div class="campo-grupo"><label class="etq" for="e">Correo</label><input id="e" v-model="email" class="campo" type="email" autocomplete="username" required></div>
          <div class="campo-grupo"><label class="etq" for="p">Contraseña</label><CampoSecreto id="p" v-model="password" autocomplete="current-password" required /></div>
          <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
          <button class="btn" type="submit" :disabled="ocupado">Continuar</button>
        </div>
      </template>
      <template v-else>
        <CodigoInput v-model="codigo" etiqueta="Código de 6 dígitos de tu aplicación" autofoco />
        <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
        <button class="btn" type="submit" :disabled="ocupado || codigo.length !== 6">Entrar</button>
      </template>
      <router-link to="/entrar" style="font-size:16px">Soy cliente: ir a mi cuenta</router-link>
    </form>
  </main>
</template>
