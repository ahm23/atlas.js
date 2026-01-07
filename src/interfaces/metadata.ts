

export interface IFolderMeta {
  name: string
  created: number
}

export interface IFileMeta {
  name: string
  size: number
  type: string

  lastModified: number
  lastUpdated: number
  created: number
}

export interface ISecurityInfo {
  view: IPermissionBundle[]
  edit: IPermissionBundle[]
}

export interface IPermissionBundle {
  address: string,
  key: string
}