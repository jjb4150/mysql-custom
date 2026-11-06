<template>
<div>
  <el-popover placement="bottom-start" title="选择要显示的列" width="240" trigger="click">
    <div class="column-picker">
      <div class="column-picker__actions">
        <el-button size="mini" @click="showAll">全选</el-button>
        <el-button size="mini" @click="hideAll">全不选</el-button>
      </div>
      <el-checkbox-group v-model="toolbar.showColumns" class="column-picker__list">
        <el-checkbox v-for="(column,index) in result.fields" :label="column.name.toLowerCase()" :key="index">
          {{ column.name }}
        </el-checkbox>
      </el-checkbox-group>
    </div>
    <el-button icon="el-icon-s-grid" circle title="选择要显示的列" size="mini" slot="reference">
    </el-button>
  </el-popover>
</div>
</template>

<script>
export default {
    props:['result','toolbar'],
    methods:{
        showAll(){
            this.toolbar.showColumns=(this.result.fields||[]).map(f=>f.name.toLowerCase())
        },
        hideAll(){
            this.toolbar.showColumns=[]
        }
    }
};
</script>

<style>
.column-picker__actions{
  margin-bottom: 6px;
  display: flex;
  gap: 6px;
}
.column-picker__list{
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>