import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'zrender-vendor',
              test: /node_modules[\\/]zrender[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
            {
              name: 'echarts-vendor',
              test: /node_modules[\\/]echarts[\\/]/,
              priority: 10,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
})
