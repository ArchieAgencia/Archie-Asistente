<script setup lang="ts">
// Campo de contraseña o clave con el «ojito» para ver lo que se escribe. Por defecto oculto; el botón es accesible (teclado y lector de pantalla).
import { ref } from 'vue';
defineOptions({ inheritAttrs: false });
defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [string] }>();
const visible = ref(false);
</script>

<template>
  <div class="secreto">
    <input v-bind="$attrs" :value="modelValue" class="campo" :type="visible ? 'text' : 'password'" @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)">
    <button class="ojo" type="button" :aria-pressed="visible" :aria-label="visible ? 'Ocultar lo que escribiste' : 'Mostrar lo que escribiste'" :title="visible ? 'Ocultar' : 'Mostrar'" @click="visible = !visible">
      <svg v-if="!visible" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg v-else viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 4.1-5M9.9 5.2A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1A3 3 0 0 1 9.9 9.9"/><path d="M2 2l20 20"/></svg>
    </button>
  </div>
</template>

<style scoped>
.secreto { position: relative; }
.secreto .campo { padding-right: 52px; }
.ojo { position: absolute; top: 0; right: 0; height: 100%; min-width: 48px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 0; border-radius: 0 10px 10px 0; color: var(--sec, #4A4668); cursor: pointer; }
.ojo:hover { color: var(--texto-v, #5B21B6); }
.ojo:focus-visible { outline: 3px solid var(--accion, #7C3AED); outline-offset: -3px; }
</style>
