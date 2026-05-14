import { ReactNode } from 'react'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { StatusBar } from './StatusBar'

interface MainLayoutProps {
  children: ReactNode
  activeTab: string
  onTabChange: (tab: string) => void
}

export function MainLayout({ children, activeTab, onTabChange }: MainLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <div className="flex h-screen">
        <aside className="w-64 border-r bg-card p-4">
          <div className="mb-8">
            <h1 className="text-xl font-bold">Orig Hub</h1>
          </div>
          <Tabs
            defaultValue="downloads"
            value={activeTab}
            onValueChange={onTabChange}
            orientation="vertical"
            className="w-full"
          >
            <TabsList className="flex flex-col h-auto w-full bg-transparent">
              <TabsTrigger value="downloads" className="justify-start w-full">
                Downloads
              </TabsTrigger>
              <TabsTrigger value="history" className="justify-start w-full">
                History
              </TabsTrigger>
              <TabsTrigger value="settings" className="justify-start w-full">
                Settings
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </aside>
        <div className="flex flex-1 flex-col">
          <main className="flex-1 p-6 overflow-auto">{children}</main>
          <StatusBar />
        </div>
      </div>
    </div>
  )
}
