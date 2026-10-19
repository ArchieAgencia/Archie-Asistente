<script setup lang="ts">
import { onMounted, ref } from 'vue';
import CodigoInput from './CodigoInput.vue';
defineProps<{ titulo: string; ocupado: boolean; error: string; peligro?: boolean; etiquetaConfirmar?: string }>();
const emit = defineEmits<{ confirmar: [codigo: string]; cancelar: [] }>();
const codigo = ref('');
const entrada = ref<InstanceType<typeof CodigoInput>>();
onMounted(() => entrada.value?.enfocar());
function enviar() { if (/^\d{6}$/.test(codigo.value)) emit('confirmar', codigo.value); }
</script>

<template>
  <div class="velo" @keydown.esc="emit('cancelar')">
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="mc-ti" @submit.prevent="enviar">
      <div style="display:flex;align-items:center;gap:16px">
        <img src="/img/pj-piensa.svg" alt="" width="70" height="84" style="flex:none">
        <div><p class="lbl v">Acción sensible</p><h1 id="mc-ti" class="titulo" style="font-size:30px;margin-top:4px">Confirma con tu <em>código</em></h1></div>
      </div>
      <div class="aviso info"><slot /></div>
      <div class="campo-grupo">
        <CodigoInput ref="entrada" v-model="codigo" etiqueta="Código de 6 dígitos de tu aplicación" />
        <p class="ayuda">Un código ya usado no sirve: espera a que cambie en tu aplicación.</p>
      </div>
      <p v-if="error" class="aviso error" role="alert">{{ error }}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <button class="btn" :class="{ peligro }" type="submit" :disabled="ocupado || codigo.length !== 6">{{ etiquetaConfirmar ?? 'Confirmar' }}</button>
        <button class="btn2" type="button" :disabled="ocupado" @click="emit('cancelar')">Cancelar</button>
      </div>
    </form>
  </div>
</template>
