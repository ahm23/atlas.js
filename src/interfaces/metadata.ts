
export interface IFileMeta {
  name: string
  size: number
  lastModified: number
  type: string
}

export interface ISecurityInfo {
  view: IPermissionBundle[]
  edit: IPermissionBundle[]
}

export interface IPermissionBundle {
  address: string,
  key: string
}