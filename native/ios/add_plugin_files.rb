#!/usr/bin/env ruby
# Registers the LytroTcp plugin Swift files into the Capacitor "App" target.
# Idempotent: re-running after `npx cap add ios` (which regenerates the project)
# re-adds them without duplicating. Run with the CocoaPods-vendored ruby/gems:
#   GEM_HOME=/opt/homebrew/opt/cocoapods/libexec ruby native/ios/add_plugin_files.rb
require 'xcodeproj'

project_path = File.expand_path('../../../ios/App/App.xcodeproj', __FILE__)
abort("Xcode project not found at #{project_path} — run `npx cap add ios` first") unless Dir.exist?(project_path)

project = Xcodeproj::Project.open(project_path)
target  = project.targets.find { |t| t.name == 'App' } or abort('App target not found')

app_group = project.main_group['App'] or abort("'App' group not found")
plugins_group = app_group['plugins'] || app_group.new_group('plugins', 'plugins')

files = ['LytroTcpConnection.swift', 'LytroTcpPlugin.swift']
files.each do |fname|
  # drop any stale reference so we don't create duplicates on re-run
  plugins_group.files.select { |f| f.display_name == fname }.each(&:remove_from_project)

  ref = plugins_group.new_reference(fname)          # path relative to the group dir
  target.add_file_references([ref])
  puts "added #{fname}"
end

project.save
puts "saved #{project_path}"
